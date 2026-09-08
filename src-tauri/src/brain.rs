//! Second-brain recall over the vault: keyword search plus semantic search
//! backed by an OpenAI-compatible embeddings endpoint (Ollama on the local
//! GPU, or any /v1/embeddings server). Vectors cache on disk keyed by file
//! mtime, so only changed files re-embed.

use std::collections::HashMap;
use std::path::Path;

use serde::{Deserialize, Serialize};

use crate::commands;
use crate::model::DocFile;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct VaultHit {
    /// Vault-relative path (what read_vault_file/write_vault_file take).
    pub rel: String,
    pub name: String,
    pub snippet: String,
    pub score: f64,
}

fn vault_files(dir: &str) -> Result<(std::path::PathBuf, Vec<DocFile>), String> {
    let base = Path::new(dir)
        .canonicalize()
        .map_err(|_| format!("vault folder not found: {dir}"))?;
    let mut out = Vec::new();
    commands::walk_vault(&base, &base, &mut out);
    Ok((base, out))
}

fn base_name(rel: &str) -> String {
    rel.rsplit(['/', '\\']).next().unwrap_or(rel).trim_end_matches(".md").to_string()
}

// ---------------------------------------------------------------------------
// Keyword search — same lowercase-substring approach as run_search, over the
// vault instead of transcripts.
// ---------------------------------------------------------------------------

pub fn search_vault_impl(dir: &str, terms: &[String], limit: usize) -> Result<Vec<VaultHit>, String> {
    let (base, files) = vault_files(dir)?;
    let needles: Vec<String> =
        terms.iter().map(|t| t.to_lowercase()).filter(|t| !t.trim().is_empty()).collect();
    if needles.is_empty() {
        return Ok(vec![]);
    }
    let mut hits: Vec<VaultHit> = Vec::new();
    for f in &files {
        let Ok(content) = std::fs::read_to_string(&f.path) else { continue };
        let lower = content.to_lowercase();
        let matched: Vec<&String> = needles.iter().filter(|n| lower.contains(n.as_str())).collect();
        if matched.is_empty() {
            continue;
        }
        // Snippet around the first match of the first matched term.
        let pos = lower.find(matched[0].as_str()).unwrap_or(0);
        let start = content[..pos].char_indices().rev().nth(120).map(|(i, _)| i).unwrap_or(0);
        let snippet: String = content[start..].chars().take(340).collect();
        let rel = Path::new(&f.path)
            .strip_prefix(&base)
            .map(|r| r.display().to_string())
            .unwrap_or_else(|_| f.name.clone());
        hits.push(VaultHit {
            name: base_name(&rel),
            rel,
            snippet: snippet.replace(['\r'], "").trim().to_string(),
            score: matched.len() as f64,
        });
    }
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(limit);
    Ok(hits)
}

// ---------------------------------------------------------------------------
// Semantic search — embeddings cached at ~/.claude/cipher-manager/.
// ---------------------------------------------------------------------------

#[derive(Serialize, Deserialize, Default)]
struct EmbFile {
    mtime: String,
    chunks: Vec<EmbChunk>,
}

#[derive(Serialize, Deserialize)]
struct EmbChunk {
    text: String,
    vec: Vec<f32>,
    #[serde(default)]
    kind: Option<String>, // "intent" | "outcome"; None on vault chunks
    #[serde(default)]
    uuid: Option<String>, // anchoring message; None = session top
}

fn index_path() -> Result<std::path::PathBuf, String> {
    let root = crate::claude::claude_root().ok_or("No ~/.claude directory")?;
    let dir = root.join("cipher-manager");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir.join("vault-embeddings.json"))
}

/// Split a markdown doc into ~1500-char chunks on heading/paragraph seams.
fn chunk_doc(content: &str) -> Vec<String> {
    const MAX: usize = 1500;
    let mut out: Vec<String> = Vec::new();
    let mut cur = String::new();
    for para in content.split("\n\n") {
        let starts_section = para.trim_start().starts_with('#');
        if !cur.is_empty() && (cur.len() + para.len() > MAX || starts_section) {
            out.push(std::mem::take(&mut cur));
        }
        // A single huge paragraph (e.g. a transcript blob) hard-wraps.
        if para.len() > MAX {
            for chunk in para.as_bytes().chunks(MAX) {
                out.push(String::from_utf8_lossy(chunk).into_owned());
            }
            continue;
        }
        if !cur.is_empty() {
            cur.push_str("\n\n");
        }
        cur.push_str(para);
    }
    if !cur.trim().is_empty() {
        out.push(cur);
    }
    out.into_iter().filter(|c| c.trim().len() > 40).collect()
}

/// POST /embeddings (OpenAI/Ollama compatible) for a batch of inputs.
fn embed(
    url: &str,
    key: &str,
    model: &str,
    inputs: &[String],
) -> Result<Vec<Vec<f32>>, String> {
    let endpoint = format!("{}/embeddings", url.trim_end_matches('/'));
    if !commands::proxy_allowed(&endpoint) {
        return Err("Embeddings URL isn't allowed (https://, or http:// on localhost).".into());
    }
    let mut req = ureq::post(&endpoint)
        .set("Content-Type", "application/json")
        .timeout(std::time::Duration::from_secs(120));
    if !key.trim().is_empty() {
        req = req.set("Authorization", &format!("Bearer {}", crate::secrets::resolve_secrets(key).trim()));
    }
    let body = serde_json::json!({ "model": model, "input": inputs });
    let resp = match req.send_string(&body.to_string()) {
        Ok(r) => r.into_string().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(code, r)) => {
            let b = r.into_string().unwrap_or_default();
            return Err(format!("embeddings HTTP {code}: {}", &b[..b.len().min(200)]));
        }
        Err(e) => return Err(format!("embeddings request failed: {e}")),
    };
    let v: serde_json::Value = serde_json::from_str(&resp).map_err(|e| e.to_string())?;
    let data = v.get("data").and_then(|d| d.as_array()).ok_or("no data in embeddings reply")?;
    let mut out = Vec::with_capacity(data.len());
    for item in data {
        let vec: Vec<f32> = item
            .get("embedding")
            .and_then(|e| e.as_array())
            .ok_or("no embedding vector")?
            .iter()
            .filter_map(|x| x.as_f64().map(|f| f as f32))
            .collect();
        out.push(vec);
    }
    if out.len() != inputs.len() {
        return Err("embeddings reply count mismatch".into());
    }
    Ok(out)
}

fn cosine(a: &[f32], b: &[f32]) -> f64 {
    let (mut dot, mut na, mut nb) = (0f64, 0f64, 0f64);
    for i in 0..a.len().min(b.len()) {
        dot += (a[i] * b[i]) as f64;
        na += (a[i] * a[i]) as f64;
        nb += (b[i] * b[i]) as f64;
    }
    if na == 0.0 || nb == 0.0 {
        0.0
    } else {
        dot / (na.sqrt() * nb.sqrt())
    }
}

/// Refresh the on-disk index for changed vault files, then rank chunks by
/// cosine similarity to the query. `query` may be empty to just (re)index.
pub fn semantic_search_impl(
    dir: &str,
    url: &str,
    key: &str,
    model: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<VaultHit>, String> {
    let (base, files) = vault_files(dir)?;
    let ipath = index_path()?;
    let mut index: HashMap<String, EmbFile> = std::fs::read_to_string(&ipath)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    let mut live: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut dirty = false;
    for f in &files {
        let rel = Path::new(&f.path)
            .strip_prefix(&base)
            .map(|r| r.display().to_string())
            .unwrap_or_else(|_| f.name.clone());
        live.insert(rel.clone());
        let mtime = f.modified.clone().unwrap_or_default();
        if index.get(&rel).map(|e| e.mtime == mtime).unwrap_or(false) {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&f.path) else { continue };
        let chunks = chunk_doc(&content);
        let mut emb_chunks = Vec::new();
        // ponytail: 32-per-batch, serial. Parallel batches if indexing ever drags.
        for batch in chunks.chunks(32) {
            let vecs = embed(url, key, model, batch)?;
            for (text, vec) in batch.iter().zip(vecs) {
                emb_chunks.push(EmbChunk { text: text.clone(), vec, kind: None, uuid: None });
            }
        }
        index.insert(rel, EmbFile { mtime, chunks: emb_chunks });
        dirty = true;
    }
    let before = index.len();
    index.retain(|rel, _| live.contains(rel));
    dirty |= index.len() != before;
    if dirty {
        let _ = std::fs::write(&ipath, serde_json::to_string(&index).map_err(|e| e.to_string())?);
    }

    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let qvec = embed(url, key, model, &[query.to_string()])?.remove(0);
    let mut hits: Vec<VaultHit> = Vec::new();
    for (rel, file) in &index {
        for c in &file.chunks {
            hits.push(VaultHit {
                rel: rel.clone(),
                name: base_name(rel),
                snippet: c.text.chars().take(340).collect(),
                score: cosine(&qvec, &c.vec),
            });
        }
    }
    hits.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));
    // One best chunk per file so results span documents.
    let mut seen = std::collections::HashSet::new();
    hits.retain(|h| seen.insert(h.rel.clone()));
    hits.truncate(limit);
    Ok(hits)
}

// ---------------------------------------------------------------------------
// Semantic search over session transcripts. Each session digests to up to 3
// chunks of its USER messages (the intent-bearing fraction — full transcripts
// are 100M+ tokens); only the most recent MAX_SESSIONS are indexed and only
// changed files re-embed. Results come back as SearchResult so the Ask page
// renders them exactly like keyword transcript hits.
// ---------------------------------------------------------------------------

const MAX_SESSIONS: usize = 300;

const SESS_INDEX_VER: u8 = 2;

#[derive(Serialize, Deserialize)]
struct SessEmb {
    mtime: String,
    #[serde(default)]
    ver: u8,
    project_id: String,
    project_name: String,
    title: Option<String>,
    chunks: Vec<EmbChunk>,
}

fn sessions_index_path() -> Result<std::path::PathBuf, String> {
    Ok(index_path()?.with_file_name("sessions-embeddings.json"))
}

/// One digest chunk with provenance: what it is and which message anchors it.
pub struct DigestChunk {
    pub text: String,
    pub kind: &'static str, // "intent" | "outcome"
    pub uuid: Option<String>,
}

const OUTCOME_CHUNKS: usize = 3;
const OUTCOME_MIN_LEN: usize = 80; // filters "Working on it." progress noise

/// Intent chunks (user messages, merged, ≤3 × ~1200 chars, anchored to the
/// first contributing message) + outcome chunks (the last ≤3 substantial
/// assistant messages, one chunk each, anchored exactly). Thinking blocks
/// never appear: event_text only reads "text" blocks on assistant events.
fn session_digest(path: &Path) -> (Option<String>, Vec<DigestChunk>) {
    let mut title: Option<String> = None;
    let mut chunks: Vec<DigestChunk> = Vec::new();
    let mut cur = String::new();
    let mut cur_uuid: Option<String> = None;
    let mut assistant: Vec<(String, Option<String>)> = Vec::new(); // rolling tail
    crate::parse::for_each_event(path, |v| {
        let kind = v.get("type").and_then(|t| t.as_str()).unwrap_or("");
        if kind == "ai-title" {
            if let Some(t) = v.get("aiTitle").and_then(|t| t.as_str()) {
                title = Some(t.to_string());
            }
            return;
        }
        let uuid = v.get("uuid").and_then(|u| u.as_str()).map(String::from);
        if kind == "assistant" {
            // Subagent chatter is not this session's conclusion.
            if v.get("isSidechain").and_then(|b| b.as_bool()) == Some(true) {
                return;
            }
            let text = crate::commands::event_text(v);
            let t = text.trim();
            if t.len() < OUTCOME_MIN_LEN {
                return;
            }
            assistant.push((t.chars().take(1200).collect(), uuid));
            if assistant.len() > OUTCOME_CHUNKS {
                assistant.remove(0); // keep only the tail — outcomes live at the end
            }
            return;
        }
        if kind != "user" || chunks.len() >= 3 {
            return;
        }
        let text = crate::commands::event_text(v);
        let t = text.trim();
        // Skip tool results / injected wrappers; keep real prompts.
        if t.len() < 20 || t.starts_with('<') || t.starts_with('{') {
            return;
        }
        if cur.len() + t.len() > 1200 && !cur.is_empty() {
            chunks.push(DigestChunk {
                text: std::mem::take(&mut cur),
                kind: "intent",
                uuid: cur_uuid.take(),
            });
            if chunks.len() >= 3 {
                return;
            }
        }
        if cur.is_empty() {
            cur_uuid = uuid;
        } else {
            cur.push('\n');
        }
        cur.push_str(&t.chars().take(1200).collect::<String>());
    });
    if !cur.trim().is_empty() && chunks.len() < 3 {
        chunks.push(DigestChunk { text: cur, kind: "intent", uuid: cur_uuid });
    }
    for (text, uuid) in assistant {
        chunks.push(DigestChunk { text, kind: "outcome", uuid });
    }
    (title, chunks)
}

pub fn semantic_search_sessions_impl(
    url: &str,
    key: &str,
    model: &str,
    query: &str,
    limit: usize,
) -> Result<Vec<crate::model::SearchResult>, String> {
    let Some(base) = crate::claude::projects_dir() else {
        return Ok(vec![]);
    };
    let hist = crate::claude::history_path_map();
    let ipath = sessions_index_path()?;
    let mut index: HashMap<String, SessEmb> = std::fs::read_to_string(&ipath)
        .ok()
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default();

    // Newest sessions first, capped — the tail of ancient history stays keyword-only.
    let mut sessions: Vec<(String, std::path::PathBuf, String, std::time::SystemTime)> = Vec::new();
    for id in crate::claude::list_project_ids() {
        let pd = base.join(&id);
        for sf in crate::claude::top_level_sessions(&pd) {
            let Some(stem) = sf.file_stem().and_then(|s| s.to_str()).map(String::from) else {
                continue;
            };
            let Ok(meta) = std::fs::metadata(&sf) else { continue };
            let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
            sessions.push((id.clone(), sf, stem, mtime));
        }
    }
    // Codex rollouts join the same index (codex- prefixed session ids).
    let mut codex_names: HashMap<String, String> = HashMap::new();
    for cs in crate::codex::scan_all_codex() {
        let Ok(meta) = std::fs::metadata(&cs.file) else { continue };
        let mtime = meta.modified().unwrap_or(std::time::UNIX_EPOCH);
        let pid = crate::codex::codex_project_id(&cs.cwd);
        codex_names.insert(pid.clone(), crate::claude::display_name(&cs.cwd));
        sessions.push((pid, cs.file.clone(), cs.id.clone(), mtime));
    }
    for ags in crate::antigravity::scan_all_antigravity() {
        // Antigravity has no per-conversation file; key mtime off the last
        // prompt time so re-indexing tracks new prompts.
        let last = ags.prompts.last().map(|(_, ms)| *ms).unwrap_or(0);
        let mtime = std::time::UNIX_EPOCH + std::time::Duration::from_millis(last.max(0) as u64);
        let pid = crate::antigravity::antigravity_project_id(&ags.cwd);
        codex_names.insert(pid.clone(), crate::claude::display_name(&ags.cwd));
        // history.jsonl is the source file for all antigravity sessions.
        let hist_file = crate::antigravity::antigravity_root()
            .map(|r| r.join("history.jsonl"))
            .unwrap_or_default();
        sessions.push((pid, hist_file, ags.id.clone(), mtime));
    }

    sessions.sort_by(|a, b| b.3.cmp(&a.3));
    sessions.truncate(MAX_SESSIONS);

    let mut names: HashMap<String, String> = HashMap::new();
    let mut live: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut dirty = false;
    for (id, sf, stem, mtime) in &sessions {
        let ikey = format!("{id}/{stem}");
        live.insert(ikey.clone());
        let mstr = format!("{:?}", mtime);
        if index.get(&ikey).map(|e| e.mtime == mstr && e.ver == SESS_INDEX_VER).unwrap_or(false) {
            continue;
        }
        let (title, chunks) = if stem.starts_with("codex-") {
            crate::codex::codex_digest(sf)
        } else if stem.starts_with("antigravity-") {
            crate::antigravity::antigravity_digest(stem)
        } else {
            session_digest(sf)
        };
        // Secrets must never reach the embeddings endpoint, the on-disk index,
        // or Ask citations — one choke point for every digest producer.
        let title = title.map(|t| crate::secrets::redact(&t));
        let mut chunks = chunks;
        for c in &mut chunks {
            c.text = crate::secrets::redact(&c.text);
        }
        if chunks.is_empty() {
            index.remove(&ikey);
            continue;
        }
        let texts: Vec<String> = chunks.iter().map(|c| c.text.clone()).collect();
        let vecs = embed(url, key, model, &texts)?;
        let name = names
            .entry(id.clone())
            .or_insert_with(|| {
                if let Some(n) = codex_names.get(id) {
                    return n.clone();
                }
                let real = crate::claude::first_cwd_in_file(sf)
                    .or_else(|| hist.get(id).cloned())
                    .unwrap_or_else(|| id.clone());
                crate::claude::display_name(&real)
            })
            .clone();
        index.insert(
            ikey,
            SessEmb {
                mtime: mstr,
                ver: SESS_INDEX_VER,
                project_id: id.clone(),
                project_name: name,
                title,
                chunks: chunks
                    .into_iter()
                    .zip(vecs)
                    .map(|(c, vec)| EmbChunk {
                        text: c.text,
                        vec,
                        kind: Some(c.kind.to_string()),
                        uuid: c.uuid,
                    })
                    .collect(),
            },
        );
        dirty = true;
    }
    let before = index.len();
    index.retain(|k, _| live.contains(k));
    dirty |= index.len() != before;
    if dirty {
        let _ = std::fs::write(&ipath, serde_json::to_string(&index).map_err(|e| e.to_string())?);
    }

    if query.trim().is_empty() {
        return Ok(vec![]);
    }
    let qvec = embed(url, key, model, &[query.to_string()])?.remove(0);
    Ok(rank_sessions(&index, &qvec, limit))
}

/// Rank sessions by cosine similarity of their best-matching chunk. Pure and
/// network-free — the session index is already resident in memory.
fn rank_sessions(
    index: &HashMap<String, SessEmb>,
    qvec: &[f32],
    limit: usize,
) -> Vec<crate::model::SearchResult> {
    let mut hits: Vec<(f64, crate::model::SearchResult)> = Vec::new();
    for (ikey, s) in index {
        let best = s
            .chunks
            .iter()
            .map(|c| (cosine(qvec, &c.vec), c))
            .max_by(|a, b| a.0.partial_cmp(&b.0).unwrap_or(std::cmp::Ordering::Equal));
        let Some((score, c)) = best else { continue };
        let session_id = ikey.rsplit('/').next().unwrap_or(ikey).to_string();
        let outcome = c.kind.as_deref() == Some("outcome");
        hits.push((
            score,
            crate::model::SearchResult {
                project_id: s.project_id.clone(),
                project_name: s.project_name.clone(),
                session_id,
                session_title: s.title.clone(),
                role: if outcome { "assistant".into() } else { "user".into() },
                timestamp: None,
                snippet: c.text.chars().take(340).collect(),
                chunk_kind: c.kind.clone(),
                message_uuid: c.uuid.clone(),
                score: Some(score),
            },
        ));
    }
    hits.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap_or(std::cmp::Ordering::Equal));
    hits.into_iter().take(limit).map(|(_, r)| r).collect()
}

#[tauri::command]
pub async fn semantic_search_sessions(
    url: String,
    key: String,
    model: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<crate::model::SearchResult>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        semantic_search_sessions_impl(&url, &key, &model, &query, limit.unwrap_or(6))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn search_vault(
    dir: String,
    terms: Vec<String>,
    limit: Option<usize>,
) -> Result<Vec<VaultHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        search_vault_impl(&dir, &terms, limit.unwrap_or(8))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn semantic_search(
    dir: String,
    url: String,
    key: String,
    model: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<VaultHit>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        semantic_search_impl(&dir, &url, &key, &model, &query, limit.unwrap_or(8))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyword_search_over_fixture_vault() {
        let dir = std::env::temp_dir().join("cm-brain-vault-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("output/meetings")).unwrap();
        std::fs::write(
            dir.join("output/meetings/2026-07-01 sync.md"),
            "# Sync

We agreed the widget rollout starts in August.
",
        )
        .unwrap();
        std::fs::write(dir.join("unrelated.md"), "grocery list: apples
").unwrap();

        let hits =
            search_vault_impl(dir.to_str().unwrap(), &["widget".into(), "rollout".into()], 5)
                .unwrap();
        assert_eq!(hits.len(), 1);
        assert!(hits[0].snippet.contains("widget rollout"));
        // Empty terms -> no scan, no hits.
        assert!(search_vault_impl(dir.to_str().unwrap(), &[], 5).unwrap().is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn chunking_and_cosine() {
        let doc = format!(
            "# Title\n\nShort intro paragraph that is long enough to keep for the index.\n\n## Section\n\n{}",
            "word ".repeat(600)
        );
        let chunks = chunk_doc(&doc);
        assert!(chunks.len() >= 2, "heading + long body should split: {}", chunks.len());
        assert!(chunks.iter().all(|c| c.len() <= 1600));

        assert!((cosine(&[1.0, 0.0], &[1.0, 0.0]) - 1.0).abs() < 1e-9);
        assert!(cosine(&[1.0, 0.0], &[0.0, 1.0]).abs() < 1e-9);
    }

    #[test]
    fn session_digest_intent_and_outcome_chunks() {
        let dir = std::env::temp_dir().join("cm-brain-digest-test");
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let f = dir.join("sess.jsonl");
        // Minimal Claude-transcript shape: type, uuid, message.content blocks.
        let lines = [
            r#"{"type":"user","uuid":"u1","message":{"content":"Please fix the OAuth refresh flow, it 401s after an hour and I cannot work out why."}}"#,
            r#"{"type":"assistant","uuid":"a1","message":{"content":[{"type":"thinking","thinking":"secret internal reasoning that must never be embedded"},{"type":"text","text":"Working on it."}]}}"#,
            r#"{"type":"assistant","uuid":"a2","message":{"content":[{"type":"text","text":"Root cause: the token cache in localStorage was never evicted on 401. I added an evict-and-retry-once wrapper around fetchTwitchInner so a dead cached token heals itself on the next call."}]}}"#,
            r#"{"type":"assistant","uuid":"a3","message":{"content":[{"type":"text","text":"All 24 tests pass and the fix is deployed; the cached-token bug is resolved by evicting on 401 and retrying once."}]}}"#,
        ];
        std::fs::write(&f, lines.join("\n")).unwrap();

        let (_title, chunks) = session_digest(&f);
        // Intent chunk: the user prompt, anchored to the first contributing message.
        let intents: Vec<_> = chunks.iter().filter(|c| c.kind == "intent").collect();
        assert_eq!(intents.len(), 1);
        assert!(intents[0].text.contains("OAuth refresh"));
        assert_eq!(intents[0].uuid.as_deref(), Some("u1"));
        // Outcome chunks: meaningful assistant messages from the tail, one per message.
        let outcomes: Vec<_> = chunks.iter().filter(|c| c.kind == "outcome").collect();
        assert_eq!(outcomes.len(), 2, "short 'Working on it.' must be filtered as progress noise");
        assert!(outcomes[0].text.contains("evict-and-retry-once"));
        assert_eq!(outcomes[0].uuid.as_deref(), Some("a2"));
        assert_eq!(outcomes[1].uuid.as_deref(), Some("a3"));
        // Thinking text must never appear in any chunk.
        assert!(chunks.iter().all(|c| !c.text.contains("secret internal reasoning")));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn rank_sessions_tags_kind_and_uuid() {
        let mut index: HashMap<String, SessEmb> = HashMap::new();
        index.insert(
            "proj-a/sess-1".into(),
            SessEmb {
                mtime: "x".into(),
                ver: 2,
                project_id: "proj-a".into(),
                project_name: "Project A".into(),
                title: Some("fix oauth".into()),
                chunks: vec![
                    EmbChunk {
                        text: "please fix oauth".into(),
                        vec: vec![1.0, 0.0],
                        kind: Some("intent".into()),
                        uuid: Some("u1".into()),
                    },
                    EmbChunk {
                        text: "evicted the stale token cache on 401 and retried once".into(),
                        vec: vec![0.0, 1.0],
                        kind: Some("outcome".into()),
                        uuid: Some("a2".into()),
                    },
                ],
            },
        );
        // Query vector closest to the OUTCOME chunk → hit is the outcome, anchored.
        let hits = rank_sessions(&index, &[0.1, 0.9], 5);
        assert_eq!(hits.len(), 1, "one best chunk per session");
        assert_eq!(hits[0].chunk_kind.as_deref(), Some("outcome"));
        assert_eq!(hits[0].message_uuid.as_deref(), Some("a2"));
        assert_eq!(hits[0].role, "assistant");
        assert_eq!(hits[0].session_id, "sess-1");
        // Query vector closest to the INTENT chunk → intent hit, user role.
        let hits = rank_sessions(&index, &[0.9, 0.1], 5);
        assert_eq!(hits[0].chunk_kind.as_deref(), Some("intent"));
        assert_eq!(hits[0].role, "user");
    }
}
