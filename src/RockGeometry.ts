/**
 * Computes smooth, area-weighted normals across coincident vertices. UV seams
 * commonly duplicate positions, which would otherwise create lighting creases.
 */
export function computeWeldedNormals(
  positions: ArrayLike<number>,
  indices: ArrayLike<number>,
): Float32Array {
  const accumulated = new Map<string, [number, number, number]>();
  const vertexKeys = new Array<string>(positions.length / 3);
  for (let vertex = 0; vertex < positions.length / 3; vertex++) {
    const offset = vertex * 3;
    const key = [
      Math.round(positions[offset] * 1e6),
      Math.round(positions[offset + 1] * 1e6),
      Math.round(positions[offset + 2] * 1e6),
    ].join(",");
    vertexKeys[vertex] = key;
    if (!accumulated.has(key)) accumulated.set(key, [0, 0, 0]);
  }

  for (let index = 0; index < indices.length; index += 3) {
    const first = indices[index] * 3;
    const second = indices[index + 1] * 3;
    const third = indices[index + 2] * 3;
    const edgeAX = positions[second] - positions[first];
    const edgeAY = positions[second + 1] - positions[first + 1];
    const edgeAZ = positions[second + 2] - positions[first + 2];
    const edgeBX = positions[third] - positions[first];
    const edgeBY = positions[third + 1] - positions[first + 1];
    const edgeBZ = positions[third + 2] - positions[first + 2];
    const normalX = edgeAY * edgeBZ - edgeAZ * edgeBY;
    const normalY = edgeAZ * edgeBX - edgeAX * edgeBZ;
    const normalZ = edgeAX * edgeBY - edgeAY * edgeBX;
    for (const vertex of [indices[index], indices[index + 1], indices[index + 2]]) {
      const normal = accumulated.get(vertexKeys[vertex])!;
      normal[0] += normalX;
      normal[1] += normalY;
      normal[2] += normalZ;
    }
  }

  const normals = new Float32Array(positions.length);
  for (let vertex = 0; vertex < vertexKeys.length; vertex++) {
    const normal = accumulated.get(vertexKeys[vertex])!;
    const inverseLength = 1 / Math.max(1e-8, Math.hypot(normal[0], normal[1], normal[2]));
    normals[vertex * 3] = normal[0] * inverseLength;
    normals[vertex * 3 + 1] = normal[1] * inverseLength;
    normals[vertex * 3 + 2] = normal[2] * inverseLength;
  }
  return normals;
}
