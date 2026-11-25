// Where the game draws a held item, as tools/itemfit.py place_matrix: grip space, row
// vectors (D3DX), vertex' = (V * mul) @ (scale * BASIS @ rot) + trans, with the shared
// [Items] trim at zero (the shipped fits are made at zero). Offsets are stored for the
// LEFT hand; the right hand mirrors offset X, yaw and roll.

export const HAND_SCALE = 1.0;          // [VR] HandScale default
// Dark props are z-up, +X forward; the game turns them into the grip: X -> -Z, Y -> -X, Z -> +Y.
export const BASIS = [[0, 0, -1], [-1, 0, 0], [0, 1, 0]];

const rad = d => d * Math.PI / 180, deg = r => r * 180 / Math.PI;
export const mul3 = (a, b) => a.map(r => [0, 1, 2].map(j => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j]));
export const T3 = a => [0, 1, 2].map(i => [a[0][i], a[1][i], a[2][i]]);
const rotX = a => { const c = Math.cos(a), s = Math.sin(a); return [[1, 0, 0], [0, c, s], [0, -s, c]]; };
const rotY = a => { const c = Math.cos(a), s = Math.sin(a); return [[c, 0, -s], [0, 1, 0], [s, 0, c]]; };
const rotZ = a => { const c = Math.cos(a), s = Math.sin(a); return [[c, s, 0], [-s, c, 0], [0, 0, 1]]; };

// D3DXMatrixRotationYawPitchRoll: roll, then pitch, then yaw (row vectors).
export const yawPitchRoll = (y, p, r) => mul3(mul3(rotZ(r), rotX(p)), rotY(y));

// Inverse of yawPitchRoll for a proper rotation: [yaw, pitch, roll] radians.
export function decomposeYPR(m) {
	const p = Math.asin(Math.max(-1, Math.min(1, -m[2][1])));
	if (Math.abs(Math.cos(p)) > 1e-6) return [Math.atan2(m[2][0], m[2][2]), p, Math.atan2(m[0][1], m[1][1])];
	return [Math.atan2(-m[0][2], m[0][0]), p, 0];
}

// The place as a rotation M (row vectors, = BASIS @ rot), a uniform scale and a translation,
// for the hand `mir` (+1 left, -1 right).
export function place(off, rot, sc, mir) {
	const r = yawPitchRoll(rad(rot[1] * mir), rad(rot[0]), rad(rot[2] * mir));
	const k = 0.01 * HAND_SCALE;
	return { M: mul3(BASIS, r), scale: sc, t: [off[0] * k * mir, off[1] * k, off[2] * k] };
}

// Back from a rotation M (row vectors) and a translation to the numbers a fit stores.
export function unplace(M, t, mir) {
	const [y, p, r] = decomposeYPR(mul3(T3(BASIS), M));
	const k = 0.01 * HAND_SCALE;
	const z = v => (Math.abs(v) < 5e-4 ? 0 : v);
	return {
		off: [z(t[0] / k * mir), z(t[1] / k), z(t[2] / k)],
		rot: [z(deg(p)), z(deg(y) * mir), z(deg(r) * mir)],
	};
}
