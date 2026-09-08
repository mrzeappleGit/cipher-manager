//! Pure text/offset helpers for mapping LanguageTool results onto native
//! fields. LT offsets are UTF-16 code units over the exact string we sent;
//! Rust strings are UTF-8; UIA's `TextUnit_Character` is provider-defined
//! (CRLF pairs and surrogate pairs may count as one "character"). Everything
//! here is side-effect free so it can be unit-tested without Windows.

/// UTF-16 length of a string.
pub fn utf16_len(s: &str) -> usize {
    s.chars().map(char::len_utf16).sum()
}

/// Byte index for a UTF-16 code-unit offset (None if out of range or if the
/// offset lands inside a surrogate pair).
pub fn u16_to_byte(s: &str, off_u16: usize) -> Option<usize> {
    if off_u16 == 0 {
        return Some(0);
    }
    let mut u16_seen = 0usize;
    for (byte_idx, ch) in s.char_indices() {
        if u16_seen == off_u16 {
            return Some(byte_idx);
        }
        u16_seen += ch.len_utf16();
    }
    (u16_seen == off_u16).then_some(s.len())
}

/// The substring covering a UTF-16 [offset, offset+length) range.
pub fn slice_u16(s: &str, off_u16: usize, len_u16: usize) -> Option<&str> {
    let start = u16_to_byte(s, off_u16)?;
    let end = u16_to_byte(s, off_u16 + len_u16)?;
    s.get(start..end)
}

/// Replace a UTF-16 range with `repl`, returning the new string.
pub fn splice_u16(s: &str, off_u16: usize, len_u16: usize, repl: &str) -> Option<String> {
    let start = u16_to_byte(s, off_u16)?;
    let end = u16_to_byte(s, off_u16 + len_u16)?;
    let mut out = String::with_capacity(s.len() + repl.len());
    out.push_str(&s[..start]);
    out.push_str(repl);
    out.push_str(&s[end..]);
    Some(out)
}

/// Normalize line endings for content comparison (`\r\n` / `\r` -> `\n`).
/// UIA providers disagree on how they spell newlines, so range text is only
/// ever compared in normalized form.
pub fn normalize_newlines(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// Count "units" in a substring under one convention: UTF-16 code units or
/// Unicode scalars, with CRLF pairs optionally collapsed to one unit.
fn count_units(s: &str, utf16: bool, crlf_as_one: bool) -> usize {
    let mut n = 0usize;
    let mut prev_cr = false;
    for ch in s.chars() {
        if crlf_as_one && prev_cr && ch == '\n' {
            prev_cr = false;
            continue; // the \n of a \r\n pair is free
        }
        prev_cr = ch == '\r';
        n += if utf16 { ch.len_utf16() } else { 1 };
    }
    n
}

/// One provider-unit interpretation of a target range, plus how many units of
/// surrounding context to expand by (same convention) for disambiguation.
#[derive(PartialEq, Clone, Copy)]
pub struct RangeCandidate {
    pub start: i32,
    pub len: i32,
    pub ctx_before: i32,
    pub ctx_after: i32,
}

/// Candidates — in provider "character" units — for a UTF-16 range of
/// `snapshot`. `Move(TextUnit_Character, …)` semantics vary by provider
/// (UTF-16 vs scalar counting, CRLF as one or two), so we produce one
/// candidate per plausible convention, deduplicated; the caller must VERIFY
/// each against the range's actual text before selecting. Each candidate also
/// carries context sizes for `ctx_u16` UTF-16 units either side (clamped to
/// the text), letting the caller verify the SURROUNDINGS too when the flagged
/// text isn't unique in the snapshot.
pub fn unit_candidates(
    snapshot: &str,
    off_u16: usize,
    len_u16: usize,
    ctx_u16: usize,
) -> Vec<RangeCandidate> {
    let Some(start_b) = u16_to_byte(snapshot, off_u16) else {
        return Vec::new();
    };
    let Some(end_b) = u16_to_byte(snapshot, off_u16 + len_u16) else {
        return Vec::new();
    };
    let (ctx_lo_b, ctx_hi_b) = context_bytes(snapshot, off_u16, len_u16, ctx_u16);
    let before = &snapshot[..start_b];
    let inside = &snapshot[start_b..end_b];
    let ctx_before = &snapshot[ctx_lo_b..start_b];
    let ctx_after = &snapshot[end_b..ctx_hi_b];

    let mut out: Vec<RangeCandidate> = Vec::new();
    for (utf16, crlf_one) in [(true, false), (true, true), (false, false), (false, true)] {
        let cand = RangeCandidate {
            start: count_units(before, utf16, crlf_one) as i32,
            len: count_units(inside, utf16, crlf_one) as i32,
            ctx_before: count_units(ctx_before, utf16, crlf_one) as i32,
            ctx_after: count_units(ctx_after, utf16, crlf_one) as i32,
        };
        if !out.contains(&cand) {
            out.push(cand);
        }
    }
    out
}

/// Byte bounds of the ±`ctx_u16`-unit window around a UTF-16 range, nudged
/// inward when an edge lands inside a surrogate pair.
fn context_bytes(s: &str, off_u16: usize, len_u16: usize, ctx_u16: usize) -> (usize, usize) {
    let total = utf16_len(s);
    let mut lo = off_u16.saturating_sub(ctx_u16);
    let lo_b = loop {
        match u16_to_byte(s, lo) {
            Some(b) => break b,
            None => lo += 1, // landed inside a surrogate pair
        }
    };
    let mut hi = (off_u16 + len_u16 + ctx_u16).min(total);
    let hi_b = loop {
        match u16_to_byte(s, hi) {
            Some(b) => break b,
            None => hi -= 1,
        }
    };
    (lo_b, hi_b)
}

/// The normalized expected text of the context window (for range verification).
pub fn context_slice(snapshot: &str, off_u16: usize, len_u16: usize, ctx_u16: usize) -> String {
    let (lo, hi) = context_bytes(snapshot, off_u16, len_u16, ctx_u16);
    normalize_newlines(&snapshot[lo..hi])
}

/// Shift issue offsets after an in-place apply at `applied_off` (UTF-16):
/// issues past the edit move by `delta`; issues overlapping it are dropped.
/// The applied issue itself must be removed by the caller beforehand.
pub fn shift_offsets<T: OffsetRange>(issues: &mut Vec<T>, applied_off: usize, applied_len: usize, delta: isize) {
    issues.retain_mut(|it| {
        let (off, len) = (it.offset(), it.length());
        if off + len <= applied_off {
            true // entirely before the edit
        } else if off >= applied_off + applied_len {
            it.set_offset((off as isize + delta) as usize);
            true
        } else {
            false // overlapped the edited region — stale
        }
    });
}

pub trait OffsetRange {
    fn offset(&self) -> usize;
    fn length(&self) -> usize;
    fn set_offset(&mut self, off: usize);
}

#[cfg(test)]
mod tests {
    use super::*;

    impl OffsetRange for (usize, usize) {
        fn offset(&self) -> usize {
            self.0
        }
        fn length(&self) -> usize {
            self.1
        }
        fn set_offset(&mut self, off: usize) {
            self.0 = off;
        }
    }

    #[test]
    fn u16_offsets_ascii() {
        let s = "hello world";
        assert_eq!(slice_u16(s, 6, 5), Some("world"));
        assert_eq!(splice_u16(s, 0, 5, "goodbye").as_deref(), Some("goodbye world"));
    }

    #[test]
    fn u16_offsets_emoji() {
        // "😀" is 2 UTF-16 units / 4 UTF-8 bytes.
        let s = "a😀b teh";
        assert_eq!(utf16_len(s), 1 + 2 + 1 + 1 + 3);
        assert_eq!(slice_u16(s, 5, 3), Some("teh"));
        assert_eq!(splice_u16(s, 5, 3, "the").as_deref(), Some("a😀b the"));
        // Offset landing inside the surrogate pair is rejected, not mangled.
        assert_eq!(u16_to_byte(s, 2), None);
    }

    #[test]
    fn u16_offsets_crlf() {
        let s = "one\r\nteh two";
        // LT counts \r\n as 2 units, so "teh" starts at 5.
        assert_eq!(slice_u16(s, 5, 3), Some("teh"));
    }

    fn pair(c: &RangeCandidate) -> (i32, i32) {
        (c.start, c.len)
    }

    #[test]
    fn candidates_cover_conventions() {
        let s = "a\r\nb\r\nteh x";
        // "teh" at u16 offset 6 (a,\r,\n,b,\r,\n). utf16: start 6; CRLF-as-one: 4.
        let c = unit_candidates(s, 6, 3, 0);
        assert!(c.iter().any(|x| pair(x) == (6, 3)));
        assert!(c.iter().any(|x| pair(x) == (4, 3)));
        // Pure-ASCII scalars == utf16, so only the two distinct candidates.
        assert_eq!(c.len(), 2);
    }

    #[test]
    fn candidates_emoji_scalar_convention() {
        let s = "😀😀teh";
        let c = unit_candidates(s, 4, 3, 0);
        assert!(c.iter().any(|x| pair(x) == (4, 3))); // utf16 units
        assert!(c.iter().any(|x| pair(x) == (2, 3))); // scalar counting (emoji = 1)
    }

    #[test]
    fn candidate_context_units_and_slice() {
        let s = "one teh two teh three";
        // Second "teh" at u16 offset 12; 6 units of context each side.
        let c = unit_candidates(s, 12, 3, 6);
        assert_eq!(pair(&c[0]), (12, 3));
        assert_eq!((c[0].ctx_before, c[0].ctx_after), (6, 6));
        assert_eq!(context_slice(s, 12, 3, 6), "h two teh three");
        // Context clamps at the ends of the text.
        let d = unit_candidates(s, 0, 3, 6);
        assert_eq!((d[0].ctx_before, d[0].ctx_after), (0, 6));
        // Context edges never split a surrogate pair.
        let e = "😀😀teh😀";
        let f = unit_candidates(e, 4, 3, 3);
        assert!(f[0].ctx_before <= 3);
        let _ = context_slice(e, 4, 3, 3); // must not panic on a pair boundary
    }

    #[test]
    fn newline_normalization() {
        assert_eq!(normalize_newlines("a\r\nb\rc\nd"), "a\nb\nc\nd");
    }

    #[test]
    fn offset_shifting() {
        // ranges: (offset, length)
        let mut v: Vec<(usize, usize)> = vec![(0, 3), (10, 4), (20, 2)];
        // apply at offset 10 len 4, replacement shorter by 2
        shift_offsets(&mut v, 10, 4, -2);
        assert_eq!(v, vec![(0, 3), (18, 2)]); // overlap dropped, tail shifted
    }
}
