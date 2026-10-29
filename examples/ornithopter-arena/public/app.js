// The arena's page: one world, every ship in it, and a choice of which to
// follow. People watch here; the pilots are agents that never see it.
// Keys: v cycles the view of the followed ship.
import * as THREE from "three";

const RAD = Math.PI / 180;
const $ = (id) => document.getElementById(id);
const SAND_LOW = new THREE.Color(0.74, 0.55, 0.33);
const SAND_HIGH = new THREE.Color(0.95, 0.83, 0.6);
const VIEWS = ["chase", "tower", "above"];

// ---------------------------------------------------------------------------
// The world
// ---------------------------------------------------------------------------

function terrainMesh(world, heights) {
	const { grid, cell, size } = world;
	const half = size / 2;
	const n = grid * grid;
	const positions = new Float32Array(n * 3);
	for (let j = 0; j < grid; j++) {
		for (let i = 0; i < grid; i++) {
			const k = (j * grid + i) * 3;
			positions[k] = -half + i * cell;
			positions[k + 1] = heights[j * grid + i];
			positions[k + 2] = half - j * cell; // sim z north is -z here
		}
	}
	const index = new Uint32Array((grid - 1) * (grid - 1) * 6);
	let t = 0;
	for (let j = 0; j < grid - 1; j++) {
		for (let i = 0; i < grid - 1; i++) {
			const a = j * grid + i;
			const b = a + 1;
			const c = a + grid;
			const d = c + 1;
			index[t++] = a;
			index[t++] = b;
			index[t++] = c;
			index[t++] = b;
			index[t++] = d;
			index[t++] = c;
		}
	}
	const geometry = new THREE.BufferGeometry();
	geometry.setAttribute("position", new THREE.BufferAttribute(positions, 3));
	geometry.setIndex(new THREE.BufferAttribute(index, 1));
	geometry.computeVertexNormals();
	// sand by height, shaded by slope: the lee faces darker, the crests pale
	const normals = geometry.getAttribute("normal");
	const colors = new Float32Array(n * 3);
	const color = new THREE.Color();
	let maxH = 1;
	for (const h of heights) if (h > maxH) maxH = h;
	for (let k = 0; k < n; k++) {
		color.copy(SAND_LOW).lerp(SAND_HIGH, Math.min(1, heights[k] / maxH));
		const shade = 0.7 + 0.3 * Math.max(0, normals.getY(k));
		colors[k * 3] = color.r * shade;
		colors[k * 3 + 1] = color.g * shade;
		colors[k * 3 + 2] = color.b * shade;
	}
	geometry.setAttribute("color", new THREE.BufferAttribute(colors, 3));
	return new THREE.Mesh(geometry, new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }));
}

// a rock column, exactly the cylinder the game collides with: a near miss on the page is a near miss in the game
function spireMesh(spire, i) {
	const height = spire.top - spire.base + 30;
	const geometry = new THREE.CylinderGeometry(spire.radius, spire.radius, height, 9, 1);
	const hue = 0.06 + ((i * 7) % 5) * 0.004;
	const material = new THREE.MeshLambertMaterial({
		color: new THREE.Color().setHSL(hue, 0.35, 0.26 + (i % 3) * 0.03),
	});
	const mesh = new THREE.Mesh(geometry, material);
	mesh.position.set(spire.x, spire.base + height / 2 - 30, -spire.z);
	mesh.rotation.y = i * 0.7;
	return mesh;
}

function skyDome() {
	const material = new THREE.ShaderMaterial({
		side: THREE.BackSide,
		depthWrite: false,
		uniforms: {},
		vertexShader: `varying vec3 vPos; void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
		fragmentShader: `varying vec3 vPos; void main() {
			float t = clamp(normalize(vPos).y, 0.0, 1.0);
			vec3 horizon = vec3(0.93, 0.78, 0.56);
			vec3 zenith = vec3(0.42, 0.6, 0.8);
			gl_FragColor = vec4(mix(horizon, zenith, pow(t, 0.55)), 1.0);
		}`,
	});
	const dome = new THREE.Mesh(new THREE.SphereGeometry(9000, 32, 16), material);
	const sun = new THREE.Mesh(new THREE.SphereGeometry(180, 16, 12), new THREE.MeshBasicMaterial({ color: 0xfff3cc }));
	sun.position.set(-4200, 3100, -5800);
	dome.add(sun);
	return dome;
}

function buildScene(world, heights) {
	const renderer = new THREE.WebGLRenderer({ antialias: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.setSize(window.innerWidth, window.innerHeight);
	document.body.prepend(renderer.domElement);

	const scene = new THREE.Scene();
	// the haze is the dome's horizon colour and ends before the terrain's edge, so the square never shows
	scene.fog = new THREE.Fog(0xedc78f, 900, 3600);
	const camera = new THREE.PerspectiveCamera(60, window.innerWidth / window.innerHeight, 1, 14000);
	window.addEventListener("resize", () => {
		camera.aspect = window.innerWidth / window.innerHeight;
		camera.updateProjectionMatrix();
		renderer.setSize(window.innerWidth, window.innerHeight);
	});

	scene.add(new THREE.HemisphereLight(0xfff1dc, 0x8c6b3c, 0.95));
	const sun = new THREE.DirectionalLight(0xfff0d0, 1.3);
	sun.position.set(-1500, 2600, -1800);
	scene.add(sun);
	const dome = skyDome();
	scene.add(dome);

	scene.add(terrainMesh(world, heights));
	for (const [i, spire] of world.spires.entries()) scene.add(spireMesh(spire, i));

	// the pad: a dark disc with a pale ring
	const pad = new THREE.Group();
	pad.position.set(world.pad.x, world.pad.height + 0.4, -world.pad.z);
	const disc = new THREE.Mesh(
		new THREE.CircleGeometry(world.pad.radius, 48),
		new THREE.MeshLambertMaterial({ color: 0x4a403a }),
	);
	disc.rotation.x = -Math.PI / 2;
	const ring = new THREE.Mesh(
		new THREE.RingGeometry(world.pad.radius - 4, world.pad.radius, 48),
		new THREE.MeshBasicMaterial({ color: 0xf5e6c8, side: THREE.DoubleSide }),
	);
	ring.rotation.x = -Math.PI / 2;
	ring.position.y = 0.2;
	pad.add(disc, ring);
	scene.add(pad);

	// the storm wall: a curtain of sand, thick at the ground and gone at the top, so no rim cuts the sky
	const wall = new THREE.Mesh(
		new THREE.CylinderGeometry(world.boundaryRadius, world.boundaryRadius, 2400, 96, 1, true),
		new THREE.ShaderMaterial({
			transparent: true,
			depthWrite: false,
			side: THREE.DoubleSide,
			uniforms: {},
			vertexShader: `varying float vUp; void main() { vUp = uv.y; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
			fragmentShader: `varying float vUp; void main() { float a = 0.5 * pow(1.0 - vUp, 1.8); gl_FragColor = vec4(0.85, 0.68, 0.44, a); }`,
		}),
	);
	wall.position.y = 1100;
	scene.add(wall);

	return { renderer, scene, camera, dome, world, clock: new THREE.Clock() };
}

// ---------------------------------------------------------------------------
// The ship, facing -z. After the film's Atreides ornithopter: a slim, angular
// body about 22 m long with a faceted canopy at the nose, eight long blades
// (four a side) on bulky shoulder hubs that fold back along the hull when
// parked, two pairs of folding legs, and two jet pods at the tail. Built
// from primitives; the proportions are the point, not the detail.
// ---------------------------------------------------------------------------

const SHIP = {
	bladeLength: 21,
	bladeRootChord: 2.6,
	bladeTipChord: 0.9,
	/** Each blade's sweep from straight out, degrees, front to back; negative is toward the nose. */
	bladeSweep: [-16, -5, 6, 17],
	/** Folded: swept back along the boom (positive sweep is toward the tail). */
	foldSweep: 72,
	/** Flap amplitude in radians, and the droop of a resting blade. */
	flap: 0.32,
	droop: -0.1,
};

/** A blade: a quad from the root to the tip along +x, the chord shrinking. */
function bladeGeometry(length, rootChord, tipChord) {
	const geometry = new THREE.BufferGeometry();
	const v = new Float32Array([
		0,
		0,
		-rootChord / 2,
		length,
		0,
		-tipChord / 2,
		length,
		0,
		tipChord / 2,
		0,
		0,
		rootChord / 2,
	]);
	geometry.setAttribute("position", new THREE.BufferAttribute(v, 3));
	geometry.setIndex([0, 1, 2, 0, 2, 3]);
	geometry.computeVertexNormals();
	return geometry;
}

function ornithopter() {
	const group = new THREE.Group();
	const hull = new THREE.MeshStandardMaterial({ color: 0x3b4149, metalness: 0.55, roughness: 0.5 });
	const dark = new THREE.MeshStandardMaterial({ color: 0x1f2328, metalness: 0.4, roughness: 0.7 });
	const glass = new THREE.MeshStandardMaterial({
		color: 0x9fc4d6,
		metalness: 0.1,
		roughness: 0.15,
		transparent: true,
		opacity: 0.85,
	});
	const blade = new THREE.MeshStandardMaterial({
		color: 0x5a5f68,
		metalness: 0.3,
		roughness: 0.6,
		side: THREE.DoubleSide,
		transparent: true,
		opacity: 0.92,
	});
	const ghost = new THREE.MeshStandardMaterial({
		color: 0x5a5f68,
		side: THREE.DoubleSide,
		transparent: true,
		opacity: 0.22,
		depthWrite: false,
	});
	const lamp = new THREE.MeshBasicMaterial({ color: 0xfff1c2 });

	// the cabin: a chunky angular box from the nose back to the hubs, a dark belly and spine
	const cabin = new THREE.Mesh(new THREE.BoxGeometry(3.6, 2.6, 8.5), hull);
	cabin.position.set(0, 0, -2.5);
	group.add(cabin);
	const belly = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.2, 10), dark);
	belly.position.set(0, -1.5, -1.5);
	group.add(belly);
	const spine = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.9, 9), dark);
	spine.position.set(0, 1.6, -1);
	group.add(spine);
	// the tail boom: long and tapering, ringed like an abdomen, a fin at the end
	const boom = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 1.4, 12, 8), hull);
	boom.rotation.x = -Math.PI / 2;
	boom.position.set(0, 0.1, 7.5);
	group.add(boom);
	for (let i = 0; i < 4; i++) {
		const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.35 - i * 0.2, 1.35 - i * 0.2, 0.4, 8), dark);
		ring.rotation.x = -Math.PI / 2;
		ring.position.set(0, 0.1, 3.5 + i * 2.6);
		group.add(ring);
	}
	const fin = new THREE.Mesh(new THREE.BoxGeometry(0.2, 1.8, 2.4), dark);
	fin.position.set(0, 1.3, 12.2);
	group.add(fin);
	// two jet pods at the tail
	for (const x of [-1.5, 1.5]) {
		const pod = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 3.2, 10), dark);
		pod.rotation.x = Math.PI / 2;
		pod.position.set(x, 0.2, 10.5);
		group.add(pod);
		const nozzle = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.35, 0.5, 10), lamp);
		nozzle.rotation.x = Math.PI / 2;
		nozzle.position.set(x, 0.2, 12.3);
		group.add(nozzle);
	}
	// the canopy: a faceted glass nose in a dark frame, two lamps beneath
	const canopy = new THREE.Mesh(new THREE.IcosahedronGeometry(1.7, 1), glass);
	canopy.position.set(0, 0.5, -7.2);
	canopy.scale.set(1.0, 0.85, 1.6);
	group.add(canopy);
	for (const [x, y, z, w, h, d] of [
		[0, 0.5, -8.2, 0.14, 2.8, 0.14],
		[-1.2, 0.5, -7.3, 0.12, 2.6, 0.12],
		[1.2, 0.5, -7.3, 0.12, 2.6, 0.12],
		[0, 1.9, -7.2, 2.6, 0.12, 1.8],
	]) {
		const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), dark);
		bar.position.set(x, y, z);
		group.add(bar);
	}
	for (const x of [-0.9, 0.9]) {
		const light = new THREE.Mesh(new THREE.SphereGeometry(0.22, 8, 6), lamp);
		light.position.set(x, -0.9, -8.4);
		group.add(light);
	}

	// the shoulder hubs and the eight blades, four a side, fanned in sweep; each with a ghost for the blur
	const wings = [];
	for (const side of [-1, 1]) {
		const hub = new THREE.Mesh(new THREE.BoxGeometry(1.6, 1.6, 3.4), dark);
		hub.position.set(side * 2.2, 1.4, -0.5);
		group.add(hub);
		SHIP.bladeSweep.forEach((sweep, i) => {
			const pivot = new THREE.Group();
			pivot.position.set(side * 2.9, 1.5 + i * 0.12, -1.6 + i * 0.75);
			const geometry = bladeGeometry(SHIP.bladeLength, SHIP.bladeRootChord, SHIP.bladeTipChord);
			const mesh = new THREE.Mesh(geometry, blade);
			const shadow = new THREE.Mesh(geometry, ghost);
			if (side < 0) {
				mesh.scale.x = -1;
				shadow.scale.x = -1;
			}
			const spar = new THREE.Mesh(new THREE.BoxGeometry(SHIP.bladeLength, 0.12, 0.14), dark);
			spar.position.set((side * SHIP.bladeLength) / 2, 0.02, -0.3);
			pivot.add(mesh, shadow, spar);
			group.add(pivot);
			wings.push({ pivot, shadow, side, sweep, phase: (i % 2) * Math.PI + i * 0.4 });
		});
	}

	// two pairs of legs under the belly, hinged, with pads
	const legs = [];
	for (const [x, z] of [
		[-1.3, -3.5],
		[1.3, -3.5],
		[-1.1, 3.2],
		[1.1, 3.2],
	]) {
		const pivot = new THREE.Group();
		pivot.position.set(x, -2.0, z);
		const leg = new THREE.Mesh(new THREE.BoxGeometry(0.26, 2.4, 0.26), dark);
		leg.position.y = -1.2;
		const pad = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.18, 1.3), dark);
		pad.position.y = -2.45;
		pivot.add(leg, pad);
		group.add(pivot);
		legs.push({ pivot });
	}
	return { group, wings, legs, deploy: 0, gear: 1 };
}

// ---------------------------------------------------------------------------
// The ships in the sky
// ---------------------------------------------------------------------------

const fmt = (v, digits = 0) => (typeof v === "number" ? v.toFixed(digits) : "–");
const side = (bearing) =>
	Math.abs(bearing) < 0.5
		? "ahead"
		: bearing > 0
			? `right ${fmt(Math.abs(bearing))}°`
			: `left ${fmt(Math.abs(bearing))}°`;

function shortest(from, to) {
	let d = (to - from) % 360;
	if (d > 180) d -= 360;
	if (d < -180) d += 360;
	return d;
}

/** One ship on the page: its model, its eased pose, its animation state. */
function addShip(view, summary) {
	const model = ornithopter();
	view.scene.add(model.group);
	const ship = {
		callsign: summary.callsign,
		model,
		latest: summary,
		smooth: {
			x: summary.x,
			y: summary.y,
			z: summary.z,
			heading: summary.heading,
			pitch: summary.pitch,
			roll: summary.roll,
		},
		flapPhase: Math.random() * 6,
		seen: performance.now(),
	};
	model.group.position.set(summary.x, summary.y + 2.6, -summary.z);
	view.ships.set(summary.callsign, ship);
	return ship;
}

function removeShip(view, callsign) {
	const ship = view.ships.get(callsign);
	if (!ship) return;
	view.scene.remove(ship.model.group);
	view.ships.delete(callsign);
	if (view.following === callsign) follow(view, "");
}

function animateShip(ship, dt) {
	const s = ship.latest;
	const { smooth, model } = ship;
	const k = 1 - Math.exp(-dt / 0.15);
	smooth.x += (s.x - smooth.x) * k;
	smooth.z += (s.z - smooth.z) * k;
	smooth.y += (s.y - smooth.y) * k;
	smooth.heading += shortest(smooth.heading, s.heading) * k;
	const parked = s.phase === "grounded" || s.phase === "landed" || s.phase === "crashed";
	const wreck = s.phase === "crashed";
	// a wreck lies tilted where it fell; a parked ship stands on its legs and leans a little forward
	smooth.pitch += ((wreck ? -12 : s.pitch - (parked ? 3 : 0)) - smooth.pitch) * k;
	smooth.roll += ((wreck ? 28 : s.roll) - smooth.roll) * k;
	const airborne = s.phase === "flying" || s.phase === "landing";
	const rate = airborne ? 5.5 + (s.phase === "landing" ? 1.5 : 0) : 0;
	ship.flapPhase += rate * 2 * Math.PI * dt;
	const ease = 1 - Math.exp(-dt / 0.6);
	model.deploy += ((airborne ? 1 : 0) - model.deploy) * ease;
	model.gear += ((s.phase === "flying" ? 0 : 1) - model.gear) * ease;
	model.group.position.set(smooth.x, smooth.y + (parked && !wreck ? 2.6 : wreck ? 0.8 : 0), -smooth.z);
	model.group.rotation.set(smooth.pitch * RAD, -smooth.heading * RAD, -smooth.roll * RAD, "YXZ");
	for (const w of model.wings) {
		const sweep = SHIP.foldSweep + (w.sweep - SHIP.foldSweep) * model.deploy;
		const flap = model.deploy * SHIP.flap * Math.sin(ship.flapPhase + w.phase);
		w.pivot.rotation.set(0, -w.side * sweep * RAD, w.side * (SHIP.droop * model.deploy + flap), "YXZ");
		w.shadow.rotation.z = w.side * (model.deploy * SHIP.flap * Math.sin(ship.flapPhase + w.phase - 1.4) - flap);
		w.shadow.visible = model.deploy > 0.5 && rate > 0;
	}
	for (const l of model.legs) l.pivot.rotation.x = (1 - model.gear) * 1.5 * (l.pivot.position.z < 0 ? -1 : 1);
}

// ---------------------------------------------------------------------------
// Following one ship: its HUD and its camera
// ---------------------------------------------------------------------------

function follow(view, callsign) {
	if (view.followSource) {
		view.followSource.close();
		view.followSource = null;
	}
	view.following = callsign;
	view.frame = null;
	$("ships").value = callsign;
	$("log").replaceChildren();
	const url = new URL(location.href);
	if (callsign) url.searchParams.set("follow", callsign);
	else url.searchParams.delete("follow");
	history.replaceState(null, "", url);
	$("hud").hidden = !callsign;
	$("banner").hidden = true;
	if (!callsign) return;
	$("who").textContent = callsign;
	const source = new EventSource(`/follow/${encodeURIComponent(callsign)}`);
	view.followSource = source;
	source.addEventListener("state", (e) => {
		view.frame = JSON.parse(e.data);
		updateHud(view.frame);
	});
	source.addEventListener("game", (e) => logEvent($("log"), JSON.parse(e.data), 8));
	source.addEventListener("gone", () => {
		$("status").textContent = `${callsign} is gone`;
	});
}

function updateHud(s) {
	const phase = $("phase");
	phase.textContent = s.phase;
	phase.className = `phase ${s.phase}`;
	$("altitude").textContent = fmt(s.altitude);
	$("clearance").textContent = fmt(s.clearance);
	$("speed").textContent = fmt(s.speed);
	$("vspeed").textContent = fmt(s.vspeed, 1);
	$("heading").textContent = fmt(s.heading);
	$("time").textContent = fmt(s.time);
	$("power").textContent = `${fmt(s.power)}%`;
	const bar = $("power-bar");
	bar.style.width = `${Math.max(0, Math.min(100, s.power))}%`;
	bar.style.background = s.power > 40 ? "var(--ok)" : s.power > 20 ? "var(--warn)" : "var(--bad)";
	$("t-heading").textContent = fmt(s.targets.heading);
	$("t-altitude").textContent = fmt(s.targets.altitude);
	$("t-speed").textContent = fmt(s.targets.speed);
	const box = $("threat-box");
	if (s.threat) {
		box.classList.add("alert");
		$("threat").className = "";
		$("threat").textContent = `${s.threat.name}  ${fmt(s.threat.distance)} m  ${side(s.threat.bearing)}  ${
			s.threat.clearance < 0 ? `${fmt(-s.threat.clearance)} m above` : `${fmt(s.threat.clearance)} m below`
		}`;
	} else {
		box.classList.remove("alert");
		$("threat").className = "muted";
		$("threat").textContent = "none ahead";
	}
	const tbox = $("traffic-box");
	if (s.traffic) {
		tbox.classList.add("alert");
		$("traffic").className = "";
		$("traffic").textContent = `${s.traffic.callsign}  ${fmt(s.traffic.distance)} m  ${side(s.traffic.bearing)}  ${
			s.traffic.altitudeDiff >= 0
				? `${fmt(s.traffic.altitudeDiff)} m above`
				: `${fmt(-s.traffic.altitudeDiff)} m below`
		}  meets in ${fmt(s.traffic.seconds)} s`;
	} else {
		tbox.classList.remove("alert");
		$("traffic").className = "muted";
		$("traffic").textContent = "no ship closing";
	}
	$("traffic-near").replaceChildren(
		...(s.trafficNear ?? []).map((t) => {
			const li = document.createElement("li");
			li.textContent = `${t.callsign} ${fmt(t.distance_m)} m ${side(t.bearing_deg)} ${t.altitude_diff_m >= 0 ? "+" : ""}${fmt(t.altitude_diff_m)} m${
				t.seconds >= 0 ? ` ${fmt(t.seconds)} s` : ""
			}`;
			return li;
		}),
	);
	$("terrain").textContent = fmt(s.terrainAhead);
	$("home").textContent = `${fmt(s.home.distance)} m, ${side(s.home.bearing)}`;
	$("boundary").textContent = fmt(s.boundary);
	$("near").replaceChildren(
		...s.near.map((o) => {
			const li = document.createElement("li");
			li.textContent = `${o.name} ${fmt(o.distance_m)} m ${side(o.bearing_deg)} top ${fmt(o.top_m)}`;
			if (o.clearance_m < 60) li.classList.add("above");
			return li;
		}),
	);
	const banner = $("banner");
	if (s.phase === "crashed") {
		banner.hidden = false;
		banner.className = "bad";
		banner.textContent = `${s.callsign} crashed: ${s.crashCause}${s.crashName ? ` ${s.crashName}` : ""}`;
	} else if (s.phase === "landed") {
		banner.hidden = false;
		banner.className = "ok";
		banner.textContent = s.home.distance < 130 ? `${s.callsign} landed on the pad` : `${s.callsign} landed`;
	} else banner.hidden = true;
}

function logEvent(list, e, keep) {
	const li = document.createElement("li");
	const text = e.kind
		? e.kind === "collision"
			? `${e.a} and ${e.b} collided, ${e.distance} m apart`
			: e.kind === "crashed"
				? `${e.callsign} crashed: ${e.cause}${e.name ? ` ${e.name}` : ""}`
				: e.kind === "joined"
					? `${e.callsign} is on the pad`
					: `${e.callsign} left (${e.reason})`
		: `${e.name} ${Object.entries(e.payload ?? {})
				.map(([k, v]) => `${k}=${typeof v === "number" ? v.toFixed(0) : v}`)
				.join(" ")}`;
	li.textContent = text;
	if (
		e.kind === "collision" ||
		e.kind === "crashed" ||
		e.name === "flight.crash" ||
		(e.name === "flight.touchdown" && e.payload?.hard)
	)
		li.className = "bad";
	else if (e.kind === "joined" || e.name === "flight.takeoff" || e.name === "flight.touchdown") li.className = "ok";
	else if (e.name?.endsWith(".warning") || e.name === "power.low") li.className = "warn";
	list.prepend(li);
	while (list.children.length > keep) list.lastChild.remove();
}

function refreshList(view) {
	const select = $("ships");
	const names = [...view.ships.keys()].sort();
	$("count").textContent =
		names.length === 0 ? "no ships up" : `${names.length} ship${names.length === 1 ? "" : "s"} up`;
	// the options are rebuilt only when the ships or their wreck marks change, and never while the menu is open:
	// a select whose options are replaced under the pointer never closes and swallows every click
	const key = names.map((c) => `${c}${view.ships.get(c).latest.phase === "crashed" ? "*" : ""}`).join(",");
	if (key === view.listKey) return;
	if (document.activeElement === select) {
		view.listDirty = true;
		return;
	}
	view.listKey = key;
	view.listDirty = false;
	const current = select.value;
	select.replaceChildren(
		new Option("nobody", ""),
		...names.map((c) => new Option(`${c}${view.ships.get(c).latest.phase === "crashed" ? " (wreck)" : ""}`, c)),
	);
	select.value = names.includes(current)
		? current
		: view.following && names.includes(view.following)
			? view.following
			: "";
}

// ---------------------------------------------------------------------------
// The streams and the Fly button
// ---------------------------------------------------------------------------

function connect(view) {
	const source = new EventSource("/stream");
	const apply = (list) => {
		const seen = new Set();
		for (const summary of list) {
			seen.add(summary.callsign);
			const ship = view.ships.get(summary.callsign) ?? addShip(view, summary);
			ship.latest = summary;
			ship.seen = performance.now();
		}
		for (const callsign of [...view.ships.keys()]) if (!seen.has(callsign)) removeShip(view, callsign);
		refreshList(view);
	};
	source.addEventListener("hello", (e) => {
		const hello = JSON.parse(e.data);
		apply(hello.ships);
		const wanted = new URL(location.href).searchParams.get("follow");
		if (wanted && view.ships.has(wanted) && view.following !== wanted) follow(view, wanted);
		$("status").textContent = `seed ${hello.seed} · view: ${VIEWS[view.viewIndex]}`;
	});
	source.addEventListener("ships", (e) => apply(JSON.parse(e.data)));
	source.addEventListener("game", (e) => logEvent($("sky-log"), JSON.parse(e.data), 6));
	source.addEventListener("error", () => {
		$("status").textContent = "stream lost; reconnecting…";
	});
	$("ships").addEventListener("change", (e) => {
		follow(view, e.target.value);
		e.target.blur();
	});
	// a rebuild that waited for the menu to close
	$("ships").addEventListener("blur", () => {
		if (view.listDirty) refreshList(view);
	});
	window.addEventListener("keydown", (e) => {
		if (e.key === "v" && !e.target.matches("select, input, textarea")) {
			view.viewIndex = (view.viewIndex + 1) % VIEWS.length;
			$("status").textContent = `view: ${VIEWS[view.viewIndex]}`;
		}
	});
	$("fly").addEventListener("click", async () => {
		const button = $("fly");
		button.disabled = true;
		try {
			const res = await fetch("/fly", { method: "POST", headers: { "x-arena": "fly" } });
			const data = await res.json();
			if (!res.ok) {
				$("status").textContent = data.error ?? "could not start a ship";
				return;
			}
			$("fly-callsign").textContent = data.callsign;
			$("cmd-claude").textContent = data.commands.claude;
			$("cmd-codex").textContent = data.commands.codex;
			$("mcp-url").textContent = data.mcpUrl;
			$("page-url").textContent = data.pageUrl;
			$("fly-panel").hidden = false;
			view.wantFollow = data.callsign;
		} finally {
			button.disabled = false;
		}
	});
	$("fly-close").addEventListener("click", () => {
		$("fly-panel").hidden = true;
	});
	for (const button of document.querySelectorAll("[data-copy]")) {
		button.addEventListener("click", async () => {
			try {
				await navigator.clipboard.writeText($(button.dataset.copy).textContent);
				button.textContent = "copied";
				setTimeout(() => {
					button.textContent = "copy";
				}, 1200);
			} catch {
				button.textContent = "select and copy";
			}
		});
	}
}

// ---------------------------------------------------------------------------
// The frame
// ---------------------------------------------------------------------------

function animate(view) {
	const { renderer, scene, camera, dome } = view;
	const forward = new THREE.Vector3();
	const target = new THREE.Vector3();
	const eye = new THREE.Vector3();
	const frame = () => {
		const dt = Math.min(view.clock.getDelta(), 0.1);
		for (const ship of view.ships.values()) animateShip(ship, dt);
		// a ship the Fly button made is followed as soon as it appears in the sky
		if (view.wantFollow && view.ships.has(view.wantFollow)) {
			follow(view, view.wantFollow);
			view.wantFollow = null;
		}
		const followed = view.following ? view.ships.get(view.following) : undefined;
		const mode = VIEWS[view.viewIndex];
		if (followed) {
			const pos = followed.model.group.position;
			forward.set(Math.sin(followed.smooth.heading * RAD), 0, -Math.cos(followed.smooth.heading * RAD));
			if (mode === "chase") {
				eye.copy(pos)
					.addScaledVector(forward, -80)
					.add(new THREE.Vector3(0, 26, 0));
				target.copy(pos).addScaledVector(forward, 50);
			} else if (mode === "tower") {
				eye.set(view.world.pad.x + 150, view.world.pad.height + 60, -view.world.pad.z + 150);
				target.copy(pos);
			} else {
				eye.copy(pos).add(new THREE.Vector3(0, 700, 0.5));
				target.copy(pos);
			}
			camera.position.lerp(eye, mode === "chase" ? 1 - Math.exp(-dt / 0.25) : 1);
		} else {
			// nobody followed: a slow circle above the pad, looking at it
			const t = performance.now() / 1000;
			eye.set(Math.sin(t * 0.05) * 420, view.world.pad.height + 160, Math.cos(t * 0.05) * 420);
			target.set(view.world.pad.x, view.world.pad.height + 20, -view.world.pad.z);
			camera.position.lerp(eye, 1 - Math.exp(-dt / 0.5));
		}
		camera.lookAt(target);
		dome.position.copy(camera.position);
		renderer.render(scene, camera);
		requestAnimationFrame(frame);
	};
	frame();
}

async function main() {
	const [world, heightsBuffer] = await Promise.all([
		fetch("/world").then((r) => r.json()),
		fetch("/heights").then((r) => r.arrayBuffer()),
	]);
	const heights = new Float32Array(heightsBuffer);
	const view = buildScene(world, heights);
	view.ships = new Map();
	view.following = "";
	view.followSource = null;
	view.frame = null;
	view.wantFollow = null;
	view.viewIndex = 0;
	view.listKey = "";
	view.listDirty = false;
	$("status").textContent = `seed ${world.seed} · ${world.limits.maxSessions} ships at most`;
	connect(view);
	animate(view);
}

main().catch((error) => {
	$("status").textContent = `could not load the world: ${error.message}`;
});
