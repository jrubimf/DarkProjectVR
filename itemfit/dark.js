// Dark Engine files, read in the browser from the helper's own Thief folder. No DOM:
// tests/web_fit_test.mjs runs this under Node against the game and tools/itemfit.py.
// Ports of tools/bin2mesh.py (LGMD), tools/itemfit.py (_lgmd, gamesys_scale,
// gamesys_names) and tools/mkmap.py (read_mis).

export const UNITS_PER_METRE = 3.28;   // dark_model::options{}

const td = new TextDecoder('latin1');
const cstr = (u8, o, n) => {
	let e = o;
	while (e < o + n && e < u8.length && u8[e]) e++;
	return td.decode(u8.subarray(o, e));
};

// ---- LGMD (.bin object models) ---------------------------------------------------
function header(u8) {
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	if (cstr(u8, 0, 4) !== 'LGMD') throw new Error('not an LGMD model');
	const version = dv.getUint32(4, true);
	if (version !== 3 && version !== 4) throw new Error('LGMD version ' + version);
	const h = { version };
	h.n_polys = dv.getUint16(60, true); h.n_verts = dv.getUint16(62, true);
	h.n_mats = u8[66]; h.n_objs = u8[69];
	const offs = ['off_objs', 'off_mats', 'off_uvs', 'off_vhots', 'off_verts', 'off_lights', 'off_normals',
		'off_polys', 'off_nodes', 'model_size'];
	offs.forEach((k, i) => { h[k] = dv.getUint32(70 + i * 4, true); });
	return { h, dv };
}

// One pass over the polygon region; null unless it lands exactly on off_nodes.
// textured: true / false for every polygon, null per polygon off its type bits
// (a model may mix them: HealingPotion's vile1.bin).
function polys(u8, dv, h, textured, matByte) {
	let p = h.off_polys;
	const out = [];
	try {
		for (let i = 0; i < h.n_polys; i++) {
			if (p + 12 > u8.length) return null;
			p += 2;                                   // index
			const data = dv.getUint16(p, true); p += 2;
			const type = u8[p++], num = u8[p++];
			p += 2 + 4;                               // normal, plane distance
			if (num < 3 || p + num * 2 > u8.length) return null;
			const v = [], uv = [];
			for (let k = 0; k < num; k++) { v.push(dv.getUint16(p, true)); p += 2; }
			p += num * 2;                             // lights
			const hasUv = textured === null ? (type & 7) === 3 : textured;
			for (let k = 0; k < num; k++) { uv.push(hasUv ? dv.getUint16(p, true) : 0); if (hasUv) p += 2; }
			if (matByte) p += 1;
			out.push({ type, v, uv, data });
		}
	} catch (e) {
		return null;                                  // ran off the end
	}
	return p === h.off_nodes ? out : null;
}

// -> { pos: Float32Array (metres, Dark axes, centred on its box), uv: Float32Array,
//      parts: [{ tris: [[vi, ti], x3, ...], material: name | null, colour: [r,g,b] | null }] }
export function parseLGMD(u8) {
	const { h, dv } = header(u8);
	const nUv = (h.off_vhots - h.off_uvs) >> 3;
	const pos = new Float32Array(h.n_verts * 3);
	for (let i = 0; i < h.n_verts * 3; i++) pos[i] = dv.getFloat32(h.off_verts + i * 4, true) / UNITS_PER_METRE;
	const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
	for (let i = 0; i < h.n_verts; i++) for (let k = 0; k < 3; k++) {
		lo[k] = Math.min(lo[k], pos[i * 3 + k]); hi[k] = Math.max(hi[k], pos[i * 3 + k]);
	}
	for (let i = 0; i < h.n_verts; i++) for (let k = 0; k < 3; k++) pos[i * 3 + k] -= 0.5 * (lo[k] + hi[k]);
	const uv = new Float32Array(Math.max(nUv, 1) * 2);
	for (let i = 0; i < nUv * 2; i++) uv[i] = dv.getFloat32(h.off_uvs + i * 4, true);

	let list = null, textured = true;
	for (const [t, m] of [[true, true], [true, false], [false, true], [false, false], [null, true], [null, false]]) {
		list = polys(u8, dv, h, t, m);
		if (list) { textured = t !== false; break; }
	}
	if (!list) throw new Error('could not parse the polygon region with any known record layout');

	// mds_mat: name[16], type (1 = colour), slot, then texture handle or rgb. A polygon names
	// its material by SLOT, else by list position (dark_model.cpp parse).
	const mats = [];
	for (let i = 0; i < h.n_mats; i++) {
		const o = h.off_mats + i * 26;
		mats.push({ name: cstr(u8, o, 16), type: u8[o + 16], slot: u8[o + 17], rgb: dv.getUint32(o + 18, true) });
	}
	const bySlot = (slot, colour) => mats.findIndex(m => m.slot === slot && (m.type === 1) === colour);
	const groups = new Map();
	for (const p of list) {
		let key = -1;
		if (textured && (p.type & 7) === 3) {
			const m = bySlot(p.data, false);
			key = m >= 0 ? m : (p.data > 0 && p.data <= mats.length ? p.data - 1 : 0);
		} else if ((p.type & 0x60) === 0x40) {
			key = bySlot(p.data, true);
		}
		if (!groups.has(key)) groups.set(key, []);
		const g = groups.get(key);
		for (let i = 1; i < p.v.length - 1; i++) {
			g.push([p.v[0], p.uv[0]], [p.v[i], p.uv[i]], [p.v[i + 1], p.uv[i + 1]]);
		}
	}
	const parts = [];
	for (const [key, tris] of groups) {
		let material = null, colour = null;
		if (key >= 0 && key < mats.length) {
			const m = mats[key];
			if (m.type === 1) colour = [(m.rgb >> 16) & 255, (m.rgb >> 8) & 255, m.rgb & 255];
			else if (m.name) material = m.name;
		}
		parts.push({ tris, material, colour });
	}
	return { pos, uv, parts };
}

// The texture names a material may be stored under in obj.crf, in the order
// itemfit.item_texture tries them (txt16 before txt).
export function textureCandidates(mat) {
	const base = mat.replace(/\.[^.]*$/, '');
	const names = ['.dds', '.png', '.tga', '.bmp'].map(e => base + e).concat([mat, base + '.gif', base + '.pcx']);
	const out = [];
	for (const sub of ['txt16/', 'txt/']) for (const n of names) out.push((sub + n).toLowerCase());
	return out;
}

// ---- PCX (8-bit paletted, RLE): the textures obj.crf mostly holds -------------------
// -> { width, height, rgba: Uint8ClampedArray } or null
export function decodePCX(u8) {
	if (u8.length < 128 + 769 || u8[0] !== 10 || u8[2] !== 1) return null;
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const bpp = u8[3], planes = u8[65], bpl = dv.getUint16(66, true);
	const w = dv.getUint16(8, true) - dv.getUint16(4, true) + 1;
	const h = dv.getUint16(10, true) - dv.getUint16(6, true) + 1;
	if (bpp !== 8 || planes !== 1 || u8[u8.length - 769] !== 12) return null;
	const pal = u8.subarray(u8.length - 768);
	const idx = new Uint8Array(bpl * h);
	for (let p = 128, o = 0; o < idx.length && p < u8.length - 769;) {
		const c = u8[p++];
		if ((c & 0xC0) === 0xC0) { const v = u8[p++]; for (let k = c & 0x3F; k > 0 && o < idx.length; k--) idx[o++] = v; }
		else idx[o++] = c;
	}
	const rgba = new Uint8ClampedArray(w * h * 4);
	for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
		const i = idx[y * bpl + x], o = (y * w + x) * 4;
		rgba[o] = pal[i * 3]; rgba[o + 1] = pal[i * 3 + 1]; rgba[o + 2] = pal[i * 3 + 2]; rgba[o + 3] = 255;
	}
	return { width: w, height: h, rgba };
}

// ---- tag files (DARK.GAM, .mis) -------------------------------------------------------
const CHUNK_HDR = 24;   // tag[12], version major, minor, pad
export function readTagFile(u8) {
	const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
	const toc = dv.getUint32(0, true), n = dv.getUint32(toc, true);
	const out = new Map();
	for (let i = 0; i < n; i++) {
		const o = toc + 4 + i * 20;
		const off = dv.getUint32(o + 12, true), size = dv.getUint32(o + 16, true);
		out.set(cstr(u8, o, 12), u8.subarray(off + CHUNK_HDR, off + CHUNK_HDR + size));
	}
	return out;
}

function records(chunks, tag) {
	const out = new Map(), d = chunks.get(tag);
	if (!d) return out;
	const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
	for (let o = 0; o + 8 <= d.length;) {
		const oid = dv.getInt32(o, true), sz = dv.getUint32(o + 4, true);
		out.set(oid, d.subarray(o + 8, o + 8 + sz));
		o += 8 + sz;
	}
	return out;
}

function metaParents(chunks) {
	const parents = new Map(), d = chunks.get('L$MetaProp');
	if (!d) return parents;
	const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
	for (let o = 0; o + 14 <= d.length; o += 14) {
		const src = dv.getInt32(o + 4, true), dst = dv.getInt32(o + 8, true);
		if (!parents.has(src)) parents.set(src, []);
		parents.get(src).push(dst);
	}
	return parents;
}

// Parse objnames.str: Key: "Text" a line. -> Map(lower key -> text)
export function parseObjnames(text) {
	const out = new Map();
	for (const line of text.split(/\r?\n/)) {
		const c = line.indexOf(':');
		const q = line.split('"');
		const k = c >= 0 ? line.slice(0, c).trim() : '';
		if (c >= 0 && q.length >= 3 && k && !k.startsWith('//')) out.set(k.toLowerCase(), q[1]);
	}
	return out;
}

// What the gamesys says about each model: { scale: Map(model -> archetype Scale, as
// itemfit.gamesys_scale), name: Map(model -> what the game calls it, as gamesys_names) }.
export function readGamesys(u8, objnames = new Map()) {
	const chunks = readTagFile(u8);
	const models = records(chunks, 'P$ModelName'), scales = records(chunks, 'P$Scale');
	const syms = records(chunks, 'P$SymName'), names = records(chunks, 'P$GameName');
	const parents = metaParents(chunks);
	const lstr = r => r && r.length > 4 ? cstr(r, 4, r.length - 4) : '';
	const own = oid => models.has(oid) ? cstr(models.get(oid), 0, models.get(oid).length).toLowerCase() : null;

	const scaleOf = (oid, depth = 0) => {
		const r = scales.get(oid);
		if (r && r.length >= 12) return vec3(r);
		if (depth > 12) return null;
		for (const p of parents.get(oid) || []) { const s = scaleOf(p, depth + 1); if (s !== null) return s; }
		return null;
	};
	// Several archetypes can name one model: the commonest Scale, the smallest on a tie.
	const found = new Map();
	for (const oid of models.keys()) {
		const m = own(oid), v = scaleOf(oid), s = v && Math.max(...v);
		if (m && s > 0) { if (!found.has(m)) found.set(m, []); found.get(m).push([s, v]); }
	}
	const scale = new Map(), scale3 = new Map();
	for (const [m, list] of found) {
		const count = v => list.filter(x => x[0] === v).length;
		const best = [...list].sort((a, b) => count(b[0]) - count(a[0]) || a[0] - b[0])[0];
		scale.set(m, best[0]);
		scale3.set(m, best[1]);
	}

	// Names: the inventory name of an archetype wearing the model (inherited), nearest the
	// one naming it; one only the gamesys names (SymName spelled out) when none has one.
	const modelOf = (oid, depth = 0) => {
		const m = own(oid);
		if (m !== null) return [m, depth];
		if (depth >= 12) return null;
		for (const p of parents.get(oid) || []) { const r = modelOf(p, depth + 1); if (r) return r; }
		return null;
	};
	const spelled = s => s.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[0-9]+$/, '').trim();
	const best = new Map();
	// Ties go to the oldest archetype (nearest -1), as the game's own walk finds it.
	for (const oid of [...new Set([...names.keys(), ...syms.keys()])].sort((a, b) => Math.abs(a) - Math.abs(b))) {
		const m = modelOf(oid);
		if (!m || !m[0]) continue;
		const raw = lstr(names.get(oid));
		let label = raw ? objnames.get(raw.split(':')[0].trim().toLowerCase()) : null;
		if (!label && raw.includes('"')) label = raw.split('"')[1];
		const rank = label ? 0 : 1;
		if (!label && syms.has(oid)) label = spelled(lstr(syms.get(oid)));
		const b = best.get(m[0]);
		if (label && (!b || rank < b[0] || (rank === b[0] && m[1] < b[1]))) best.set(m[0], [rank, m[1], label]);
	}
	const name = new Map([...best].map(([m, v]) => [m, v[2]]));
	return { scale, scale3, name, gam: { models, scales, parents } };
}

const vec3 = r => { const dv = new DataView(r.buffer, r.byteOffset, 12); return [0, 4, 8].map(o => dv.getFloat32(o, true)); };

// Every Scale one mission puts a model at: Map(model -> [x, y, z][]), distinct to 0.01. Each
// object placed in the .mis, its own Scale else its archetype's (the mission's links and
// properties over the gamesys's), 1 when none says.
export function missionScales(u8, gam) {
	const chunks = readTagFile(u8);
	const models = new Map([...gam.models, ...records(chunks, 'P$ModelName')]);
	const scales = new Map([...gam.scales, ...records(chunks, 'P$Scale')]);
	const parents = new Map(gam.parents);
	for (const [k, v] of metaParents(chunks)) parents.set(k, [...(parents.get(k) || []), ...v]);
	const walk = (oid, rec, depth = 0) => {
		if (rec.has(oid)) return rec.get(oid);
		if (depth > 12) return null;
		for (const p of parents.get(oid) || []) { const r = walk(p, rec, depth + 1); if (r) return r; }
		return null;
	};
	const out = new Map();
	for (const oid of parents.keys()) {
		if (oid <= 0) continue;          // archetypes are negative; placed objects positive
		const mr = walk(oid, models), sr = walk(oid, scales);
		if (!mr) continue;
		const v = (sr && sr.length >= 12 ? vec3(sr) : [1, 1, 1]).map(x => Math.round(x * 100) / 100);
		if (!v.every(x => x > 0 && x < 100)) continue;     // junk Scales some missions carry
		const m = cstr(mr, 0, mr.length).toLowerCase();
		if (!out.has(m)) out.set(m, new Map());
		out.get(m).set(v.join(','), v);
	}
	return new Map([...out].map(([m, s]) => [m, [...s.values()]]));
}
