// 2D PCA via power iteration on the data matrix.
// Avoids materializing the (D x D) covariance matrix — D can be 768.

function dot(a: Float32Array, b: Float32Array): number {
  let s = 0
  for (let i = 0; i < a.length; i++) s += a[i]! * b[i]!
  return s
}

function norm(a: Float32Array): number {
  return Math.sqrt(dot(a, a))
}

function scale(a: Float32Array, k: number): void {
  for (let i = 0; i < a.length; i++) a[i] = a[i]! * k
}

// Top right singular vector of X (N x D matrix flattened row-major).
function topSingularVector(X: Float32Array, N: number, D: number, iters = 30): Float32Array {
  const v = new Float32Array(D)
  // Seed deterministically — reproducible layouts across reloads.
  for (let i = 0; i < D; i++) v[i] = Math.sin(i * 12.9898 + 78.233)
  scale(v, 1 / norm(v))

  const u = new Float32Array(N)
  for (let t = 0; t < iters; t++) {
    // u = X v
    for (let i = 0; i < N; i++) {
      let s = 0
      const off = i * D
      for (let j = 0; j < D; j++) s += X[off + j]! * v[j]!
      u[i] = s
    }
    // v = X^T u
    v.fill(0)
    for (let i = 0; i < N; i++) {
      const ui = u[i]!
      const off = i * D
      for (let j = 0; j < D; j++) v[j] = v[j]! + X[off + j]! * ui
    }
    const n = norm(v)
    if (n === 0) break
    scale(v, 1 / n)
  }
  return v
}

// PCA project N x D embeddings to 2D. Returns flattened (N x 2) Float32Array.
//
// Each row is L2-normalized first so magnitude can't dominate variance. If
// `fitIndices` is supplied, the principal axes (mean, v1, v2) are computed
// from that subset only — useful when one source has hundreds of near-
// duplicate embeddings that would otherwise yank the first PC toward itself.
// All rows are still projected onto the basis. tanh squash is computed on
// the full projection so the layout fills the canvas without piling outliers
// at the corners.
export function pca2D(rowsRaw: number[][], fitIndices?: number[]): Float32Array {
  const N = rowsRaw.length
  if (N === 0) return new Float32Array(0)
  const D = rowsRaw[0]!.length

  // Pack into Float32Array, L2-normalize each row.
  const X = new Float32Array(N * D)
  for (let i = 0; i < N; i++) {
    const r = rowsRaw[i]!
    let s = 0
    for (let j = 0; j < D; j++) s += r[j]! * r[j]!
    const inv = s > 1e-12 ? 1 / Math.sqrt(s) : 1
    const off = i * D
    for (let j = 0; j < D; j++) X[off + j] = r[j]! * inv
  }

  const fit = fitIndices && fitIndices.length > 0 ? fitIndices : null
  const fitN = fit ? fit.length : N

  // Mean over fit set (or all rows if no fit subset).
  const mean = new Float32Array(D)
  if (fit) {
    for (const i of fit) {
      const off = i * D
      for (let j = 0; j < D; j++) mean[j] = mean[j]! + X[off + j]!
    }
  } else {
    for (let i = 0; i < N; i++) {
      const off = i * D
      for (let j = 0; j < D; j++) mean[j] = mean[j]! + X[off + j]!
    }
  }
  for (let j = 0; j < D; j++) mean[j] = mean[j]! / fitN

  // Center every row.
  for (let i = 0; i < N; i++) {
    const off = i * D
    for (let j = 0; j < D; j++) X[off + j] = X[off + j]! - mean[j]!
  }

  // Build the fit-subset matrix for SVD if needed.
  const fitMatrix = fit
    ? (() => {
        const M = new Float32Array(fitN * D)
        for (let k = 0; k < fitN; k++) {
          const i = fit[k]!
          const sOff = i * D
          const dOff = k * D
          for (let j = 0; j < D; j++) M[dOff + j] = X[sOff + j]!
        }
        return M
      })()
    : X

  // First component.
  const v1 = topSingularVector(fitMatrix, fitN, D)
  // Project all rows.
  const xs = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const off = i * D
    let s = 0
    for (let j = 0; j < D; j++) s += X[off + j]! * v1[j]!
    xs[i] = s
  }
  // Deflate fit matrix and full matrix in lockstep so v2 is orthogonal to v1
  // in both spaces.
  if (fit) {
    for (let k = 0; k < fitN; k++) {
      const i = fit[k]!
      const xi = xs[i]!
      const dOff = k * D
      for (let j = 0; j < D; j++) fitMatrix[dOff + j] = fitMatrix[dOff + j]! - xi * v1[j]!
    }
  }
  for (let i = 0; i < N; i++) {
    const off = i * D
    const xi = xs[i]!
    for (let j = 0; j < D; j++) X[off + j] = X[off + j]! - xi * v1[j]!
  }

  // Second component.
  const v2 = topSingularVector(fitMatrix, fitN, D)
  const ys = new Float32Array(N)
  for (let i = 0; i < N; i++) {
    const off = i * D
    let s = 0
    for (let j = 0; j < D; j++) s += X[off + j]! * v2[j]!
    ys[i] = s
  }

  // tanh squash centered on the median, scale = 1.4 * std (computed on the
  // FULL distribution so visible spread is balanced, not just the fit subset).
  const out = new Float32Array(N * 2)
  const xCenter = median(xs)
  const yCenter = median(ys)
  const xScale = 1.4 * std(xs, xCenter)
  const yScale = 1.4 * std(ys, yCenter)
  for (let i = 0; i < N; i++) {
    out[i * 2] = Math.tanh((xs[i]! - xCenter) / (xScale || 1))
    out[i * 2 + 1] = Math.tanh((ys[i]! - yCenter) / (yScale || 1))
  }
  return out
}

function median(arr: Float32Array): number {
  if (arr.length === 0) return 0
  const sorted = Array.from(arr).sort((a, b) => a - b)
  const m = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? ((sorted[m - 1] ?? 0) + (sorted[m] ?? 0)) / 2 : sorted[m] ?? 0
}

function std(arr: Float32Array, center: number): number {
  if (arr.length === 0) return 1
  let s = 0
  for (let i = 0; i < arr.length; i++) {
    const d = arr[i]! - center
    s += d * d
  }
  return Math.sqrt(s / arr.length)
}
