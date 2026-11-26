// The web item fitter: the helper's own Thief folder in, fits out as a GitHub issue.
// The maths is place.js (= tools/itemfit.py place_matrix), the game files dark.js.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { TransformControls } from 'three/addons/controls/TransformControls.js';
import { parseLGMD, textureCandidates, decodePCX, readGamesys, parseObjnames, missionScales } from './dark.js';
import { place, unplace, T3, sizeRatio, FIST_AT, PINCH_AT, FIST_W, PINCH_W } from './place.js';

const REPO = 'jrubimf/DarkProjectVR';      // where fits are sent (issues) and published
const $ = id => document.getElementById(id);
const status = t => { $('status').textContent = t; };
const ITEM_COLOUR = [120, 170, 255];       // a face with no texture found

// ---- per-viewer storage (drafts survive a reload; never required) ---------------------
const store = {
	get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
	set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private window */ } },
};

// ---- the helper's game folder ------------------------------------------------------------
// read(path) -> Uint8Array | null; paths relative to the game folder, any case.
async function fromHandle(dir) {
	const find = async (d, parts) => {
		for await (const [name, h] of d.entries()) {
			if (name.toLowerCase() !== parts[0]) continue;
			if (parts.length === 1) return h.kind === 'file' ? h : null;
			if (h.kind === 'directory') return find(h, parts.slice(1));
		}
		return null;
	};
	return {
		label: dir.name,
		async read(path) {
			const h = await find(dir, path.toLowerCase().split('/'));
			return h ? new Uint8Array(await (await h.getFile()).arrayBuffer()) : null;
		},
	};
}
function fromFileList(files) {
	const map = new Map();
	let label = '';
	for (const f of files) {
		const parts = f.webkitRelativePath.split('/');
		label = parts[0];
		map.set(parts.slice(1).join('/').toLowerCase(), f);
	}
	return { label, async read(path) { const f = map.get(path.toLowerCase()); return f ? new Uint8Array(await f.arrayBuffer()) : null; } };
}
function fromUrl(base) {     // ?game=<url>: tools/web_fit_serve.py's /game/, for testing
	return {
		label: base,
		async read(path) { const r = await fetch(base + path); return r.ok ? new Uint8Array(await r.arrayBuffer()) : null; },
	};
}

// ---- state -------------------------------------------------------------------------------
const S = {
	set: 'tgold', crf: null, crfNames: null, sys: { scale: new Map(), scale3: new Map(), name: new Map() },
	shipped: new Map(), models: [], current: null, mir: -1, pose: 'None',
	fits: {},          // model -> { off, rot, sc, pose } the helper changed (drafts)
	cache: new Map(),  // model -> loaded meshes
	sizes: new Map(),  // model -> [{ v: [x, y, z], missions: [title] }]: Scales the missions put it at
	size: null,        // the one being previewed, else the fitted size
	ext: [0, 0, 0],    // the picked item's extents at its archetype Scale, metres
};

function parseIni(text) {
	const out = new Map();
	let sec = null;
	for (const raw of text.split(/\r?\n/)) {
		const line = raw.trim();
		if (!line || line.startsWith(';')) continue;
		const m = line.match(/^\[(.+)\]$/);
		if (m) { sec = new Map(); out.set(m[1].trim().toLowerCase(), sec); continue; }
		const e = line.indexOf('=');
		if (sec && e > 0) sec.set(line.slice(0, e).trim().toLowerCase(), line.slice(e + 1).trim());
	}
	return out;
}
const nums = (s, n, d) => { const v = (s || '').split(',').map(Number); return v.length === n && v.every(Number.isFinite) ? v : d; };

// The shipped fit: what a player gets without one of their own.
function shippedFit(m) {
	const s = S.shipped.get('item ' + m);
	return {
		off: nums(s?.get('offset'), 3, [0, 0, 0]), rot: nums(s?.get('rot'), 3, [0, 0, 0]),
		sc: Number.isFinite(Number(s?.get('scale'))) && s?.get('scale') ? Number(s.get('scale')) : 1,
		pose: POSES.find(p => p.toLowerCase() === (s?.get('pose') || 'none').toLowerCase()) || 'None', found: !!s,
	};
}
const fitOf = m => S.fits[m] || shippedFit(m);
const same = (a, b) => a.pose === b.pose && Math.abs(a.sc - b.sc) < 5e-4
	&& [0, 1, 2].every(k => Math.abs(a.off[k] - b.off[k]) < 5e-3 && Math.abs(a.rot[k] - b.rot[k]) < 0.05);

// ---- three.js ----------------------------------------------------------------------------
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(40, 1, 0.005, 20);
const orbit = new OrbitControls(camera, canvas);
const GRIP = [-0.0008, -0.0610, 0.0135];          // the fist's grip point, RIGHT hand (itemfit.FIST)
orbit.target.set(GRIP[0], GRIP[1], GRIP[2]);
scene.add(new THREE.HemisphereLight(0xffffff, 0x404040, 1.6));
const sun = new THREE.DirectionalLight(0xffffff, 1.4);
sun.position.set(0.4, 0.6, 0.5);
scene.add(sun);
const theme = () => {
	const light = matchMedia('(prefers-color-scheme: light)').matches;
	scene.background = new THREE.Color(light ? 0xe9e4da : 0x1b1a18);
};
theme();
matchMedia('(prefers-color-scheme: light)').addEventListener?.('change', theme);

// Grip axes (red +X, green +Y, blue +Z, 4 cm) and the grip point.
scene.add(new THREE.AxesHelper(0.04));
const cross = new THREE.Group();
for (const ax of [[1, 0, 0], [0, 1, 0], [0, 0, 1]]) {
	const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...ax).multiplyScalar(-0.008), new THREE.Vector3(...ax).multiplyScalar(0.008)]);
	cross.add(new THREE.Line(g, new THREE.LineBasicMaterial({ color: 0xff4040 })));
}
scene.add(cross);

const itemObj = new THREE.Group();     // the place: position, rotation, scale
scene.add(itemObj);
const gizmo = new TransformControls(camera, canvas);
gizmo.setSize(0.8);
gizmo.setSpace('world');
scene.add(gizmo);
gizmo.addEventListener('dragging-changed', e => { orbit.enabled = !e.value; });
gizmo.addEventListener('objectChange', () => fromObject());

function resize() {
	const r = canvas.parentElement.getBoundingClientRect();
	renderer.setSize(r.width, r.height, false);
	camera.aspect = r.width / Math.max(1, r.height);
	camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
renderer.setAnimationLoop(() => { orbit.update(); renderer.render(scene, camera); });

// ---- the hand ----------------------------------------------------------------------------
const hand = { meta: null, blocks: new Map(), geo: null, mesh: null };
let POSES = ['None'];
async function loadHand() {
	hand.meta = await (await fetch('data/hand.json')).json();
	const buf = await (await fetch('data/hand.bin')).arrayBuffer();
	const nv = hand.meta.verts, nt = hand.meta.tris;
	const uv = new Float32Array(buf, 0, nv * 2);
	const idx = new Uint32Array(buf, nv * 8, nt * 3);
	let o = nv * 8 + nt * 12;
	for (const b of hand.meta.blocks) { hand.blocks.set(b, new Float32Array(buf, o, nv * 3)); o += nv * 12; }
	hand.geo = new THREE.BufferGeometry();
	hand.geo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
	hand.geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
	hand.geo.setIndex(new THREE.BufferAttribute(idx, 1));
	const tex = await new THREE.TextureLoader().loadAsync('data/hand.png');
	tex.flipY = false;
	tex.colorSpace = THREE.SRGBColorSpace;
	hand.mesh = new THREE.Mesh(hand.geo, new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide }));
	scene.add(hand.mesh);
	POSES = Object.keys(hand.meta.poses);
	$('pose').innerHTML = POSES.map(p => `<option>${p}</option>`).join('');
	GRIP.splice(0, 3, ...hand.meta.grip_point);
}
// The hand in `pose`, LEFT hand mirrored across X for the right.
function poseHand() {
	if (!hand.geo) return;
	const block = hand.blocks.get(hand.meta.poses[S.pose] ?? hand.meta.fist) || hand.blocks.get(hand.meta.fist);
	const pos = hand.geo.attributes.position.array;
	for (let i = 0; i < pos.length; i += 3) {
		pos[i] = block[i] * S.mir;          // the model is a left hand (mir +1); the right is its mirror
		pos[i + 1] = block[i + 1];
		pos[i + 2] = block[i + 2];
	}
	hand.geo.attributes.position.needsUpdate = true;
	hand.geo.computeVertexNormals();
	hand.geo.computeBoundingSphere();
	cross.position.set(GRIP[0] * -S.mir, GRIP[1], GRIP[2]);
}

// ---- items -------------------------------------------------------------------------------
async function texture(material) {
	for (const n of textureCandidates(material)) {
		const entry = S.crfNames.get(n);
		if (!entry) continue;
		const u8 = await entry.async('uint8array');
		let tex = null;
		if (n.endsWith('.pcx')) {
			const p = decodePCX(u8);
			if (p) tex = new THREE.DataTexture(p.rgba, p.width, p.height, THREE.RGBAFormat);
		} else if (/\.(png|gif|bmp)$/.test(n)) {
			try { tex = new THREE.Texture(await createImageBitmap(new Blob([u8]))); } catch { tex = null; }
		}
		if (!tex) continue;
		tex.flipY = false;                   // v = 0 is the top row, as the game samples it
		tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
		tex.magFilter = THREE.NearestFilter;
		tex.colorSpace = THREE.SRGBColorSpace;
		tex.needsUpdate = true;
		return tex;
	}
	return null;
}

async function loadItem(m) {
	if (S.cache.has(m)) return S.cache.get(m);
	const entry = S.crfNames.get(m + '.bin');
	if (!entry) throw new Error(m + '.bin is not in obj.crf');
	const model = parseLGMD(await entry.async('uint8array'));
	const mul = S.sys.scale.get(m) ?? 1;     // the archetype's Scale, as the game draws it
	const group = new THREE.Group();
	for (const part of model.parts) {
		const n = part.tris.length;
		const pos = new Float32Array(n * 3), uv = new Float32Array(n * 2);
		part.tris.forEach(([vi, ti], i) => {
			for (let k = 0; k < 3; k++) pos[i * 3 + k] = model.pos[vi * 3 + k] * mul;
			uv[i * 2] = model.uv[ti * 2] ?? 0; uv[i * 2 + 1] = model.uv[ti * 2 + 1] ?? 0;
		});
		const geo = new THREE.BufferGeometry();
		geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
		geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
		geo.computeVertexNormals();
		const map = part.material ? await texture(part.material) : null;
		const c = part.colour || ITEM_COLOUR;
		const mat = new THREE.MeshLambertMaterial({ side: THREE.DoubleSide, map,
			color: map ? 0xffffff : new THREE.Color(c[0] / 255, c[1] / 255, c[2] / 255).convertSRGBToLinear() });
		group.add(new THREE.Mesh(geo, mat));
	}
	const out = { group, mul };
	S.cache.set(m, out);
	return out;
}

// ---- the place <-> the object --------------------------------------------------------------
function toObject() {
	const f = fitOf(S.current);
	const p = place(f.off, f.rot, f.sc, S.mir);
	const M = p.M;      // row vectors: three's column matrix is its transpose
	const m4 = new THREE.Matrix4().set(M[0][0], M[1][0], M[2][0], 0, M[0][1], M[1][1], M[2][1], 0,
		M[0][2], M[1][2], M[2][2], 0, 0, 0, 0, 1);
	itemObj.position.set(...p.t);
	itemObj.quaternion.setFromRotationMatrix(m4);
	itemObj.scale.setScalar(p.scale);
	applySize();
}
function applySize() {
	// A mission's size, drawn as the game draws a pouch item at it (comp::item_size): grown
	// along the model's axes about the point of the hand holding it. The fit itself is unchanged.
	const g = itemObj.children[0];
	if (!g) return;
	if (!S.size) { g.scale.setScalar(1); g.position.set(0, 0, 0); return; }
	const f = fitOf(S.current);
	const pinch = ['pinch', 'key', 'tripod'].includes(f.pose.toLowerCase());
	const arch = S.sys.scale3.get(S.current) || [1, 1, 1];
	const r = sizeRatio(S.size, arch, S.ext.map(v => v * itemObj.scale.x), pinch ? PINCH_W : FIST_W);
	const at = pinch ? PINCH_AT : FIST_AT;
	itemObj.updateMatrixWorld();
	const pl = itemObj.worldToLocal(new THREE.Vector3(at[0] * S.mir, at[1], at[2]));
	g.scale.set(...r);
	g.position.set(pl.x * (1 - r[0]), pl.y * (1 - r[1]), pl.z * (1 - r[2]));
}
function fromObject() {
	const e = new THREE.Matrix4().makeRotationFromQuaternion(itemObj.quaternion).elements;
	const M = [[e[0], e[1], e[2]], [e[4], e[5], e[6]], [e[8], e[9], e[10]]];   // = (column matrix)^T
	const back = unplace(M, itemObj.position.toArray(), S.mir);
	setFit({ off: back.off, rot: back.rot, sc: itemObj.scale.x, pose: fitOf(S.current).pose }, false);
	applySize();
}

function setFit(f, move = true) {
	const m = S.current;
	if (!m) return;
	const r = v => Math.round(v * 100) / 100;
	f = { off: f.off.map(r), rot: f.rot.map(v => Math.round(v * 10) / 10), sc: Math.round(f.sc * 1000) / 1000, pose: f.pose };
	if (same(f, shippedFit(m))) delete S.fits[m];
	else S.fits[m] = f;
	store.set('itemfit:' + S.set, S.fits);
	if (move) toObject();
	showFit();
	fillList();
	showSubs();
}

// ---- UI ------------------------------------------------------------------------------------
const FIELDS = [['X cm', 'off', 0, 0.5], ['Y cm', 'off', 1, 0.5], ['Z cm', 'off', 2, 0.5],
	['Pitch', 'rot', 0, 5], ['Yaw', 'rot', 1, 5], ['Roll', 'rot', 2, 5], ['Scale', 'sc', 0, 0.05]];
$('fields').innerHTML = FIELDS.map(([l, k, i], n) =>
	`<div class="row"><span>${l}</span><input id="f${n}" type="number" step="any"><button data-n="${n}" data-d="-1">-</button><button data-n="${n}" data-d="1">+</button></div>`).join('');
const readField = (f, n, v) => { const [, k, i] = FIELDS[n]; if (k === 'sc') f.sc = Math.max(0.01, v); else f[k][i] = v; };
const copyFit = f => ({ off: [...f.off], rot: [...f.rot], sc: f.sc, pose: f.pose });
FIELDS.forEach((_, n) => {
	$('f' + n).addEventListener('change', e => { const f = copyFit(fitOf(S.current)); readField(f, n, Number(e.target.value) || 0); setFit(f); });
});
$('fields').addEventListener('click', e => {
	const b = e.target.closest('button');
	if (!b || !S.current) return;
	const n = Number(b.dataset.n), d = Number(b.dataset.d), f = copyFit(fitOf(S.current));
	const [, k, i, step] = FIELDS[n];
	readField(f, n, (k === 'sc' ? f.sc : f[k][i]) + d * step);
	setFit(f);
});
const fmt = f => `${f.off.map(v => v.toFixed(2)).join(', ')} | ${f.rot.map(v => v.toFixed(1)).join(', ')} | ${f.sc.toFixed(3)} | ${f.pose}`;
function showFit() {
	const m = S.current;
	if (!m) return;
	const f = fitOf(m), d = shippedFit(m);
	FIELDS.forEach(([, k, i], n) => { $('f' + n).value = k === 'sc' ? f.sc : f[k][i]; });
	$('pose').value = f.pose;
	if (S.pose !== f.pose) { S.pose = f.pose; poseHand(); }
	$('vals').innerHTML = `<tr><td>Shipped</td><td>${d.found ? fmt(d) : 'none yet (drawn at zero)'}</td></tr>`
		+ `<tr><td>Yours</td><td class="${S.fits[m] ? 'changed' : ''}">${S.fits[m] ? fmt(f) : 'same as shipped'}</td></tr>`;
}

function fillList() {
	const q = $('filter').value.trim().toLowerCase();
	$('list').innerHTML = S.models.filter(m => !q || m.includes(q) || (S.sys.name.get(m) || '').toLowerCase().includes(q))
		.map(m => `<div data-m="${m}" class="${m === S.current ? 'sel' : ''}"><span class="mark">${S.fits[m] ? '*' : S.shipped.has('item ' + m) ? 'd' : ''}</span>${m} <span class="name">${S.sys.name.get(m) || ''}</span></div>`)
		.join('');
}
$('list').addEventListener('click', e => { const d = e.target.closest('[data-m]'); if (d) pick(d.dataset.m); });
$('filter').addEventListener('input', fillList);
$('filter').addEventListener('keydown', e => {
	if (e.key !== 'Enter' || !S.crf) return;
	const m = e.target.value.trim().toLowerCase();
	if (!S.crfNames.has(m + '.bin')) { status(m + '.bin is not in obj.crf'); return; }
	if (!S.models.includes(m)) S.models.push(m);
	e.target.value = '';
	pick(m);
});

async function pick(m) {
	S.current = m;
	fillList();
	try {
		status('loading ' + m + '...');
		const it = await loadItem(m);
		itemObj.clear();
		it.group.scale.setScalar(1);
		it.group.position.set(0, 0, 0);
		S.ext = new THREE.Box3().setFromObject(it.group).getSize(new THREE.Vector3()).toArray();
		itemObj.add(it.group);
		gizmo.attach(itemObj);
		fillSizes();
		toObject();
		const name = S.sys.name.get(m);
		$('title').innerHTML = `<b>${m}</b>${name ? ' &middot; ' + name : ''}<br><span class="small">archetype Scale x${it.mul.toFixed(2)}</span>`;
		showFit();
		status('');
	} catch (e) {
		itemObj.clear();
		gizmo.detach();
		status(m + ': ' + e.message);
	}
}

// The Scales the missions put this model at, to see the fit at each.
function fillSizes() {
	const list = S.sizes.get(S.current) || [];
	const arch = S.sys.scale.get(S.current) ?? 1;
	const txt = v => (v.every(x => x === v[0]) ? 'x' + v[0].toFixed(2) : v.map(x => x.toFixed(2)).join(' x '));
	$('size').innerHTML = `<option value="">Fitted (archetype x${arch.toFixed(2)})</option>`
		+ list.map((s, i) => `<option value="${i}">${txt(s.v)}: ${s.missions.join(', ')}</option>`).join('');
	$('size').disabled = !list.length;
	S.size = null;
}
$('size').addEventListener('change', e => { S.size = e.target.value === '' ? null : S.sizes.get(S.current)[e.target.value].v; toObject(); });

$('pose').addEventListener('change', e => { const f = copyFit(fitOf(S.current)); f.pose = e.target.value; setFit(f); });
$('hands').addEventListener('click', e => {
	const b = e.target.closest('button');
	if (!b) return;
	S.mir = b.dataset.h === 'right' ? -1 : 1;
	for (const x of $('hands').children) x.classList.toggle('on', x === b);
	poseHand();
	if (S.current) toObject();
});
const setMode = mode => { gizmo.setMode(mode); for (const x of $('modes').querySelectorAll('[data-m]')) x.classList.toggle('on', x.dataset.m === mode); };
$('modes').addEventListener('click', e => { const b = e.target.closest('[data-m]'); if (b) setMode(b.dataset.m); });
$('space').addEventListener('click', () => {
	gizmo.setSpace(gizmo.space === 'world' ? 'local' : 'world');
	$('space').textContent = gizmo.space === 'world' ? 'Axes: grip' : 'Axes: item';
});
addEventListener('keydown', e => {
	if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT') return;
	if (e.key === 'w') setMode('translate');
	if (e.key === 'e') setMode('rotate');
	if (e.key === 'q') $('space').click();
});
$('toDefault').addEventListener('click', () => { if (S.current) { delete S.fits[S.current]; setFit(shippedFit(S.current)); } });
$('zero').addEventListener('click', () => { if (S.current) setFit({ off: [0, 0, 0], rot: [0, 0, 0], sc: 1, pose: fitOf(S.current).pose }); });

// Camera presets, as tools/itemfit_gui.py's views: the palm is -X on the right hand.
const VIEWS = [['Palm', () => [S.mir, 0, 0]], ['Back', () => [-S.mir, 0, 0]], ['Tube', () => [0, 0, 1]],
	['Fingertips', () => [0, -1, 0]], ['Forearm', () => [0, 1, 0]], ['3/4', () => [0.6 * S.mir, 0.35, 0.7]]];
$('views').innerHTML = VIEWS.map(([n], i) => `<button data-v="${i}">${n}</button>`).join('');
$('views').addEventListener('click', e => {
	const b = e.target.closest('[data-v]');
	if (!b) return;
	const d = new THREE.Vector3(...VIEWS[b.dataset.v][1]()).normalize().multiplyScalar(0.55);
	camera.up.set(...(Math.abs(d.y) > 0.3 ? [1, 0, 0] : [0, 1, 0]));
	camera.position.copy(orbit.target).add(d);
	camera.lookAt(orbit.target);
});

// ---- sending -------------------------------------------------------------------------------
const fitIni = (m, f) => [`[item ${m}]`,
	`Offset=${f.off.map(v => v.toFixed(2)).join(',')}`, `Rot=${f.rot.map(v => v.toFixed(2)).join(',')}`,
	`Scale=${f.sc.toFixed(3)}`, `Pose=${f.pose}`].join('\n');
function iniText() {
	return Object.entries(S.fits).sort().map(([m, f]) => fitIni(m, f)).join('\n\n');
}

// Ctrl+C / Ctrl+V on the page (not in a text field or over selected text): the picked
// item's fit as an [item] block, pasted onto another item after a confirm.
const typing = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName) || String(getSelection()) !== '';
document.addEventListener('copy', e => {
	if (typing() || !S.current) return;
	e.preventDefault();
	e.clipboardData.setData('text/plain', fitIni(S.current, fitOf(S.current)));
	status('copied ' + S.current);
});
document.addEventListener('paste', e => {
	if (typing() || !S.current) return;
	const [name, sec] = [...parseIni(e.clipboardData.getData('text/plain'))].find(([, s]) => s.has('offset')) || [];
	if (!sec) { status('paste: no [item] block with Offset= on the clipboard'); return; }
	e.preventDefault();
	const cur = fitOf(S.current);
	const f = { off: nums(sec.get('offset'), 3, cur.off), rot: nums(sec.get('rot'), 3, cur.rot),
		sc: Number(sec.get('scale')) || cur.sc,
		pose: POSES.find(p => p.toLowerCase() === (sec.get('pose') || '').toLowerCase()) || cur.pose };
	const from = name.replace(/^item\s+/, '');
	if (!confirm(`Replace ${S.current}'s fit with ${from}'s?\n\n${fmt(f)}`)) return;
	setFit(f);
	status(`pasted ${from} onto ${S.current}`);
});
function showSubs() {
	const n = Object.keys(S.fits).length;
	$('subs').textContent = n ? iniText() : 'None yet: every item you change is listed here.';
	for (const id of ['send', 'copy', 'clear']) $(id).disabled = !n;
}
$('copy').addEventListener('click', async () => {
	try { await navigator.clipboard.writeText(iniText()); status('copied'); } catch { status('could not copy: select the text above'); }
});
$('clear').addEventListener('click', () => { S.fits = {}; store.set('itemfit:' + S.set, S.fits); showSubs(); fillList(); if (S.current) { toObject(); showFit(); } });
$('send').addEventListener('click', () => {
	const models = Object.keys(S.fits).sort();
	const title = `[fit] ${S.set}: ${models.slice(0, 6).join(', ')}${models.length > 6 ? ` +${models.length - 6}` : ''}`;
	const body = `Item fits from the web fitter, for \`assets/items/${S.set}.ini\`.\n\n\`\`\`ini\n${iniText()}\n\`\`\`\n\n`
		+ 'Anything about how they feel (optional):\n';
	open(`https://github.com/${REPO}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`, '_blank', 'noopener');
});

// ---- opening the game ----------------------------------------------------------------------
// Every size each mission (miss1.mis .. miss30.mis in the folder) puts a model at, other
// than its archetype's own, with the missions' titles (titles.str, else the file name).
async function scanMissions(src, titles) {
	const out = new Map();
	for (let n = 1; n <= 30; n++) {
		const u8 = await src.read(`miss${n}.mis`);
		if (!u8) continue;
		status(`reading miss${n}.mis...`);
		let found;
		try { found = missionScales(u8, S.sys.gam); } catch { continue; }
		const title = titles.get('title_' + n) || `miss${n}`;
		for (const [m, list] of found) {
			const arch = S.sys.scale3.get(m) || [1, 1, 1];
			for (const v of list) {
				if (v.every((x, k) => Math.abs(x - arch[k]) < 0.05)) continue;
				if (!out.has(m)) out.set(m, []);
				const e = out.get(m).find(e => e.v.join() === v.join());
				if (e) { if (!e.missions.includes(title)) e.missions.push(title); } else out.get(m).push({ v, missions: [title] });
			}
		}
	}
	for (const list of out.values()) list.sort((a, b) => Math.max(...a.v) - Math.max(...b.v));
	return out;
}

async function openGame(src) {
	status('reading ' + src.label + '...');
	const crf = await src.read('RES/obj.crf') || await src.read('obj.crf');
	if (!crf) { status('No RES\\obj.crf in that folder: pick the folder Thief is installed in.'); return; }
	S.crf = await JSZip.loadAsync(crf);
	S.crfNames = new Map();
	S.crf.forEach((path, entry) => { if (!entry.dir) S.crfNames.set(path.toLowerCase(), entry); });
	const t2 = !!(await src.read('thief2.exe') || await src.read('Thief2VR.exe'));
	S.set = t2 ? 't2' : 'tgold';
	let objnames = new Map(), titles = new Map();
	const strings = await src.read('RES/strings.crf');
	if (strings) {
		const z = await JSZip.loadAsync(strings);
		const f = Object.values(z.files).find(f => ['english/objnames.str', 'objnames.str'].includes(f.name.toLowerCase()));
		if (f) objnames = parseObjnames(new TextDecoder('latin1').decode(await f.async('uint8array')));
		const t = Object.values(z.files).find(f => ['english/titles.str', 'titles.str'].includes(f.name.toLowerCase()));
		if (t) titles = parseObjnames(new TextDecoder('latin1').decode(await t.async('uint8array')));
	}
	const gam = await src.read('DARK.GAM');
	if (gam) S.sys = readGamesys(gam, objnames);
	S.sizes = gam ? await scanMissions(src, titles) : new Map();
	S.shipped = parseIni(await (await fetch(`data/sets/${S.set}.ini`)).text());
	const defaults = await (await fetch('data/items.json')).json();
	const fromSet = [...S.shipped.keys()].filter(k => k.startsWith('item ') && !k.includes('#')).map(k => k.slice(5));
	S.models = [...new Set([...defaults, ...fromSet])].filter(m => S.crfNames.has(m + '.bin'));
	S.fits = store.get('itemfit:' + S.set, {});
	S.cache.clear();
	$('welcome').style.display = 'none';
	$('game').textContent = `${t2 ? 'Thief 2' : 'Thief Gold'} (${src.label}): ${S.models.length} items`
		+ (gam ? '' : ' (no DARK.GAM: sizes may be off)');
	fillList();
	showSubs();
	const want = new URLSearchParams(location.search).get('item');      // ?item=key1: open on that model
	if (S.models.length) await pick(want && S.crfNames.has(want + '.bin') ? want : S.models[0]);
	const v = new URLSearchParams(location.search).get('view');         // ?view=0..5: a camera preset
	if (v) $('views').querySelector(`[data-v="${v}"]`)?.click();
	status('');
}
$('open').addEventListener('click', async () => {
	if (window.showDirectoryPicker) {
		try { await openGame(await fromHandle(await showDirectoryPicker({ mode: 'read' }))); } catch (e) { if (e.name !== 'AbortError') status(e.message); }
	} else {
		$('pick').click();
	}
});
$('pick').addEventListener('change', e => { if (e.target.files.length) openGame(fromFileList(e.target.files)); });

resize();
await loadHand();
poseHand();
$('views').querySelector('[data-v="5"]').click();
const dev = new URLSearchParams(location.search).get('game');
if (dev) openGame(fromUrl(dev));
