/** Unit-length copy; a zero vector stays zero so it never scores, and so does a non-finite one. */
export function normalize(vector: Float32Array): Float32Array {
  let sum = 0;
  for (const v of vector) sum += v * v;
  const out = new Float32Array(vector.length);
  // Not `sum === 0`: a NaN anywhere in the vector makes the sum NaN, which would otherwise divide
  // through and give every row a NaN score that no comparison can reject.
  if (!(sum > 0)) return out;
  const inv = 1 / Math.sqrt(sum);
  for (let i = 0; i < vector.length; i++) out[i] = (vector[i] as number) * inv;
  return out;
}

/** Dot products of a unit query against every row of a row-major matrix of unit vectors. */
export function scores(matrix: Float32Array, dims: number, query: Float32Array): Float32Array {
  const rows = dims === 0 ? 0 : Math.floor(matrix.length / dims);
  const out = new Float32Array(rows);
  for (let r = 0; r < rows; r++) {
    let dot = 0;
    const base = r * dims;
    for (let d = 0; d < dims; d++) dot += (matrix[base + d] as number) * (query[d] as number);
    out[r] = dot;
  }
  return out;
}

/** Indices of the `k` highest scores, best first; ties keep row order. */
export function topK(values: Float32Array, k: number): number[] {
  const indices = Array.from(values.keys());
  indices.sort((a, b) => (values[b] as number) - (values[a] as number) || a - b);
  return indices.slice(0, Math.max(0, k));
}
