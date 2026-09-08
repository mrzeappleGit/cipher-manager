// Minimal line diff (LCS) for the Memory Inbox update preview. Notes are
// small; O(n*m) is fine. ponytail: swap for a real diff lib if notes grow.

export interface DiffLine {
  t: "same" | "add" | "del";
  line: string;
}

export function lineDiff(a: string, b: string): DiffLine[] {
  const A = a ? a.split(/\r?\n/) : [];
  const B = b ? b.split(/\r?\n/) : [];
  const n = A.length;
  const m = B.length;
  // lcs[i][j] = LCS length of A[i..] and B[j..]
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i][j] = A[i] === B[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
    }
  }
  const out: DiffLine[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (A[i] === B[j]) {
      out.push({ t: "same", line: A[i] });
      i++; j++;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      out.push({ t: "del", line: A[i] });
      i++;
    } else {
      out.push({ t: "add", line: B[j] });
      j++;
    }
  }
  while (i < n) out.push({ t: "del", line: A[i++] });
  while (j < m) out.push({ t: "add", line: B[j++] });
  return out;
}
