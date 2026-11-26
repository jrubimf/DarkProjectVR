// Where the game draws a held item, as tools/itemfit.py place_matrix: grip space, row
// vectors (D3DX), vertex' = (V * mul) @ (scale * BASIS @ rot) + trans, with the shared
// [Items] trim at zero (the shipped fits are made at zero). Offsets are stored for the
// LEFT hand; the right hand mirrors offset X, yaw and roll. Fits are made looking at the right
// hand, so the left is the derived one: it also turns the item to reflect it across the axis it
// is symmetric in (mirrorAxis), which plain mirroring only gets right for one symmetric in Y.

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

// The model axis (0 X, 1 Y, 2 Z) a mesh is most nearly symmetric across, through the middle of
// its box: src\comp\modules\dark_model.cpp mirror_axis and tools/itemfit.py mirror_axis, which
// this must agree with. `pos` is x,y,z per vertex, `tris` the vertex indices the faces use. The
// corners once each (to 10 um); each reflected across the plane, its distance to the nearest
// corner, averaged, over the box diagonal. Y unless another axis beats it by more than 0.002.
export function mirrorAxis(pos, tris) {
	const seen = new Set(), P = [];
	for (const i of tris) {
		const q = [0, 1, 2].map(k => Math.round(pos[i * 3 + k] * 1e5));
		const key = q.join(',');
		if (!seen.has(key)) { seen.add(key); P.push(q.map(v => v * 1e-5)); }
	}
	if (P.length < 2) return 1;
	const lo = [0, 1, 2].map(k => Math.min(...P.map(v => v[k]))), hi = [0, 1, 2].map(k => Math.max(...P.map(v => v[k])));
	const diag = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
	if (!(diag > 0)) return 1;
	const score = [0, 1, 2].map(k => {
		let sum = 0;
		for (const v of P) {
			const r = [...v];
			r[k] = lo[k] + hi[k] - r[k];
			let best = Infinity;
			for (const w of P) best = Math.min(best, (r[0] - w[0]) ** 2 + (r[1] - w[1]) ** 2 + (r[2] - w[2]) ** 2);
			sum += Math.sqrt(best);
		}
		return sum / P.length / diag;
	});
	let best = 0;
	for (let k = 1; k < 3; k++) if (score[k] < score[best]) best = k;
	return score[1] <= score[best] + 0.002 ? 1 : best;
}

// The left hand reflects the item across its symmetric axis, not always Y: mirroring the place
// reflects the model in Y, and Y times the reflection in `axis` is a half turn about the third
// (model side, row vectors; identity for Y).
export const mirrorTurn = axis => axis === 0 ? [[-1, 0, 0], [0, -1, 0], [0, 0, 1]]
	: axis === 2 ? [[1, 0, 0], [0, -1, 0], [0, 0, -1]] : [[1, 0, 0], [0, 1, 0], [0, 0, 1]];

// The place as a rotation M (row vectors, = BASIS @ rot, after mirrorTurn in the left hand), a
// uniform scale and a translation, for the hand `mir` (+1 left, -1 right).
export function place(off, rot, sc, mir, axis = 1) {
	const r = yawPitchRoll(rad(rot[1] * mir), rad(rot[0]), rad(rot[2] * mir));
	const k = 0.01 * HAND_SCALE;
	const M = mul3(BASIS, r);
	return { M: mir > 0 ? mul3(mirrorTurn(axis), M) : M, scale: sc, t: [off[0] * k * mir, off[1] * k, off[2] * k] };
}

// Back from a rotation M (row vectors) and a translation to the numbers a fit stores.
export function unplace(M, t, mir, axis = 1) {
	if (mir > 0) M = mul3(mirrorTurn(axis), M);     // the turn is its own inverse
	const [y, p, r] = decomposeYPR(mul3(T3(BASIS), M));
	const k = 0.01 * HAND_SCALE;
	const z = v => (Math.abs(v) < 5e-4 ? 0 : v);
	return {
		off: [z(t[0] / k * mir), z(t[1] / k), z(t[2] / k)],
		rot: [z(deg(p)), z(deg(y) * mir), z(deg(r) * mir)],
	};
}

// src\comp\game\item_size.hpp: a pouch item a mission resized, against its tuned size.
// ratio(obj Scale, archetype Scale, extents at the tuned size in metres, hold width) -> r per
// model axis; it grows from the tuned size about FIST_AT or PINCH_AT (LEFT hand; right mirrors X).
export const FIST_AT = [0.0008, -0.0610, 0.0135], PINCH_AT = [0.0197, -0.0564, -0.0125];
export const FIST_W = 0.09, PINCH_W = 0.10;
const middle = (a, b, c) => a + b + c - Math.max(a, b, c) - Math.min(a, b, c);
export function sizeRatio(obj, arch, ext, hold) {
	const r = [0, 1, 2].map(k => (arch[k] > 0 && obj[k] > 0 ? obj[k] / arch[k] : 1));
	const w1 = middle(...ext), wr = middle(ext[0] * r[0], ext[1] * r[1], ext[2] * r[2]);
	const cap = Math.max(w1, hold * HAND_SCALE), g = Math.max(...r);
	let u = wr > cap && wr > 0 ? cap / wr : 1;
	u = Math.max(Math.min(u, 2 / g), 0.5 / g);
	return r.map(v => v * u);
}
