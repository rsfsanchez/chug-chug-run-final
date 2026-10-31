"use strict";

/* Pure game rules are separate from the DOM so physics and collisions can be checked in Node. */
const CHUG_GEOMETRY = Object.freeze({
  worldHeight: 480,
  groundY: 350,
  runnerWidth: 160,
  runnerHeight: 176,
  runnerFeet: 141.6,
  runnerArtTop: 14.4, // Conservative y=18 in the 200x220 SVG, rendered at 0.8 scale.
  jumpTopMargin: 24,
  runnerVisualPadding: 10 // Covers the 7px sip glow and 3px running bob.
});
// The head starts at SVG y=18.94; the backpack, tube, and animated limbs are lower.
// Round down to y=18 and include glow/bob padding around the complete artwork.
// The scene scales uniformly to the gameplay viewport, with its top at world y=0.
const MAX_JUMP_HEIGHT = CHUG_GEOMETRY.groundY - CHUG_GEOMETRY.runnerFeet
  + CHUG_GEOMETRY.runnerArtTop - CHUG_GEOMETRY.jumpTopMargin - CHUG_GEOMETRY.runnerVisualPadding;
const SINGLE_JUMP_HEIGHT = MAX_JUMP_HEIGHT * 0.88;
const SINGLE_JUMP_AIRTIME = 1.2;

const CHUG_RULES = Object.freeze({
  ...CHUG_GEOMETRY,
  maxJumpHeight: MAX_JUMP_HEIGHT,
  jumpHeight: SINGLE_JUMP_HEIGHT,
  jumpAirtime: SINGLE_JUMP_AIRTIME, // Keep the existing conservative obstacle-spacing budget.
  doubleJumpAirtime: 1.35,
  // Preserve the existing ascent and height; only the descent accelerates faster.
  gravity: 8 * SINGLE_JUMP_HEIGHT / SINGLE_JUMP_AIRTIME ** 2,
  jumpImpulse: 4 * SINGLE_JUMP_HEIGHT / SINGLE_JUMP_AIRTIME,
  fallGravityMultiplier: 1.5,
  scrollSpeed: 210,
  levelDistance: 500,
  levelSpeedIncrease: 0.08,
  maximumSpeedMultiplier: 1.6,
  maximumScrollSpeed: 336,
  speedResponse: 1.5,
  horizontalSpeed: 260,
  cameraResponse: 2.4,
  cameraLead: 20,
  maximumCameraBoost: 260,
  maxBehindMeters: 1.5,
  recoverySeconds: 4,
  viewportInset: 6,
  slideDuration: 0.12,
  metersPerPixel: 0.05,
  waterScore: 10,
  hazardPenalty: 15,
  tankCapacity: 20000,
  invulnerability: 3,
  damageFlashDuration: 0.2,
  damageFadePeriod: 0.4,
  hazardGap: 300,
  hazardRecovery: 0.65,
  ventInactive: 2.2,
  ventWarning: 1,
  ventActive: 1.2
});

const CHUG_DIFFICULTIES = Object.freeze({
  easy: Object.freeze({ label: "Easy", spacingMultiplier: 1.35, reactionTime: 0.9 }),
  normal: Object.freeze({ label: "Normal", spacingMultiplier: 1, reactionTime: 0.65 }),
  hard: Object.freeze({ label: "Hard", spacingMultiplier: 0.9, reactionTime: 0.48 })
});

const CHUG_HAZARDS = Object.freeze({
  barrel: { width: 132, height: 136, cue: "JUMP!" },
  spill: { width: 132, height: 26, cue: "JUMP!" },
  cactus: { width: 110, height: 125, cue: "JUMP!" },
  "cactus-overhead": { width: 272, height: 300, cue: "SLIDE ↓" },
  barrier: { width: 272, height: 300, cue: "SLIDE ↓" },
  vent: { width: 112, height: 164, cue: "VENT OFF" },
  boulder: { width: 200, height: 94, cue: "JUMP / LAND" },
  "prickly-pear": { width: 118, height: 116, cue: "JUMP!" }
});

// The same vertices/pads drive the natural obstacle artwork and solid geometry.
// Rock coordinates use a 240x120 viewBox; cactus pads use a 140x140 viewBox.
const CHUG_BOULDERS = Object.freeze([
  { width: 200, height: 94, top: [[28, 48], [59, 27], [96, 24], [133, 28], [170, 22], [203, 38], [216, 58]] },
  { width: 230, height: 84, top: [[26, 56], [46, 33], [84, 24], [121, 22], [158, 27], [194, 35], [216, 57]] },
  { width: 176, height: 108, top: [[30, 52], [54, 29], [87, 20], [126, 18], [164, 29], [194, 45], [212, 64]] }
]);
const CHUG_PRICKLY_PEARS = Object.freeze([
  { width: 118, height: 116, pads: [[68, 115, 15, 23], [65, 82, 18, 24], [35, 77, 20, 25], [100, 61, 20, 27], [64, 40, 19, 29]] },
  { width: 138, height: 112, pads: [[67, 119, 16, 19], [64, 93, 19, 24], [35, 95, 21, 25], [26, 58, 18, 25], [102, 86, 20, 27], [103, 45, 18, 24], [66, 46, 17, 24]] },
  { width: 106, height: 128, pads: [[72, 116, 16, 22], [69, 86, 22, 27], [38, 67, 19, 25], [106, 89, 20, 24], [80, 39, 20, 27]] }
]);

// Sample tapered, curved cactus limbs once. The same silhouette is drawn and
// collided with; the roadside trunk and its rear arms are outside the lane.
function cactusTube(nodes) {
  const samples = [];
  const curve = (a, b, c, d, t) => 0.5 * ((2 * b) + (-a + c) * t
    + (2 * a - 5 * b + 4 * c - d) * t * t + (-a + 3 * b - 3 * c + d) * t * t * t);
  for (let segment = 0; segment < nodes.length - 1; segment += 1) {
    const a = nodes[Math.max(0, segment - 1)], b = nodes[segment];
    const c = nodes[segment + 1], d = nodes[Math.min(nodes.length - 1, segment + 2)];
    for (let step = 0; step < 8; step += 1) samples.push(b.map((_, axis) => curve(a[axis], b[axis], c[axis], d[axis], step / 8)));
  }
  samples.push([...nodes.at(-1)]);
  const normals = samples.map((point, index) => {
    const before = samples[Math.max(0, index - 1)], after = samples[Math.min(samples.length - 1, index + 1)];
    const length = Math.hypot(after[0] - before[0], after[1] - before[1]);
    return [-(after[1] - before[1]) / length, (after[0] - before[0]) / length];
  });
  const edge = side => samples.map(([x, y, radius], index) => [x + normals[index][0] * radius * side, y + normals[index][1] * radius * side]);
  const cap = (point, angle) => Array.from({ length: 9 }, (_, index) => [
    point[0] + Math.cos(angle - Math.PI * index / 8) * point[2],
    point[1] + Math.sin(angle - Math.PI * index / 8) * point[2]
  ]);
  const polygon = [...edge(1), ...cap(samples.at(-1), Math.atan2(normals.at(-1)[1], normals.at(-1)[0])),
    ...edge(-1).reverse(), ...cap(samples[0], Math.atan2(normals[0][1], normals[0][0]) - Math.PI)]
    .map(point => point.map(value => Math.round(value * 100) / 100));
  return { samples, normals, polygon };
}

const cactusPath = points => `M${points.map(point => point.map(value => Number(value.toFixed(2))).join(" ")).join("L")}Z`;
const cactusBounds = polygon => {
  const xs = polygon.map(point => point[0]), ys = polygon.map(point => point[1]);
  return { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
};

const CHUG_CACTI = Object.freeze([
  { name: "sweeping-saguaro",
    trunk: [[234, 228, 23], [233, 192, 23], [235, 135, 21], [238, 80, 18], [235, 35, 15]],
    rear: [[[232, 128, 16], [199, 121, 15], [178, 101, 13], [179, 66, 11]],
      [[242, 168, 14], [258, 153, 11], [257, 119, 9]]],
    front: [[[233, 167, 18], [204, 177, 19], [156, 188, 21], [95, 186, 22], [53, 181, 21], [34, 162, 17], [33, 130, 13]]] },
  { name: "forked-saguaro",
    trunk: [[233, 229, 22], [237, 185, 22], [234, 124, 20], [230, 70, 18], [232, 28, 14]],
    rear: [[[232, 112, 16], [205, 105, 14], [194, 80, 12], [194, 50, 10]],
      [[240, 153, 13], [259, 131, 11], [256, 94, 9]]],
    front: [[[234, 154, 18], [210, 169, 18], [171, 181, 20], [130, 187, 22], [81, 186, 23], [48, 173, 20], [35, 147, 15], [37, 113, 12]],
      [[144, 183, 15], [128, 164, 14], [129, 134, 10]]] },
  { name: "crooked-saguaro",
    trunk: [[235, 228, 23], [234, 188, 22], [240, 139, 21], [242, 88, 18], [238, 43, 15]],
    rear: [[[236, 119, 15], [207, 104, 14], [203, 78, 11], [207, 45, 9]],
      [[241, 168, 14], [260, 154, 10], [258, 128, 8]]],
    front: [[[232, 168, 19], [199, 175, 19], [158, 181, 22], [116, 187, 23], [72, 186, 22], [43, 177, 19], [29, 151, 15], [29, 123, 11]],
      [[169, 180, 15], [161, 154, 13], [169, 120, 10]]] }
].map(design => {
  const branches = design.front.map(cactusTube);
  // Every arrangement has the same low point: world Y=260. The slide hitbox
  // begins at Y=270, preserving the existing 10px of forgiving headroom.
  const shift = 210 - Math.max(...branches.flatMap(branch => branch.polygon.map(point => point[1])));
  for (const branch of branches) {
    branch.samples.forEach(point => { point[1] += shift; });
    branch.polygon.forEach(point => { point[1] = Math.round((point[1] + shift) * 100) / 100; });
    branch.path = cactusPath(branch.polygon);
    branch.bounds = cactusBounds(branch.polygon);
  }
  // The object origin is groundY - 300 = 50. Plant its root at world Y=318,
  // the far road edge, rather than leaving its base at background height 302.
  // Extend only the lower trunk; the overhead silhouettes/clearance stay put.
  const rootY = 268;
  const trunkNodes = design.trunk.map(node => [...node]);
  trunkNodes[0] = [trunkNodes[0][0], rootY - 21, 27];
  return Object.freeze({ name: design.name, rootY, trunk: cactusTube(trunkNodes), rear: design.rear.map(cactusTube), branches });
}));

// Timber and pipe supports still meet the track at Y=350. The cactus grows
// on the far sand shoulder, with only its forward branches crossing the lane.
const CHUG_OVERHANGS = Object.freeze({
  cactus: CHUG_CACTI[0],
  sign: { supports: "low-sign-supports", face: "low-sign-art",
    solids: [[8, 158, 228, 24, 3], [8, 186, 228, 24, 3]] },
  pipe: { supports: "low-pipe-supports", face: "low-pipe-art",
    solids: [[8, 176, 248, 34, 8], [36, 172, 16, 38, 3], [168, 172, 16, 38, 3]] }
});

const COMMUNITY_TANK_KEY = "chug-chug-run.community-water.v1";
const TANK_MILESTONES = Object.freeze([25, 50, 75, 100]);

function cactusObstacleArt(object, part) {
  const design = CHUG_CACTI[Number.isInteger(object.variant) ? object.variant : 0];
  const prefix = `saguaro-${object.id}-${part}`;
  const front = part === "front";
  const skin = (branch, index) => {
    const id = `${prefix}-${index}`;
    const edge = fraction => branch.samples.map(([x, y, radius], point) => [
      x + branch.normals[point][0] * radius * fraction, y + branch.normals[point][1] * radius * fraction
    ]);
    const ribbon = (a, b) => cactusPath([...edge(a), ...edge(b).reverse()]);
    const ribs = [-0.64, -0.23, 0.19, 0.57].map((fraction, rib) => {
      const line = edge(fraction).map(point => point.map(value => value.toFixed(2)).join(" ")).join("L");
      return `<path d="M${line}" fill="none" stroke="${rib % 2 ? "#e0dfaa" : "#345f42"}" stroke-opacity="${rib % 2 ? ".48" : ".34"}" stroke-width="${front ? "1.4" : "1.1"}" stroke-linecap="round"/>`;
    }).join("");
    const spines = branch.samples.flatMap(([x, y, radius], point) => {
      if (point <= 3 || point % 13 !== 0) return [];
      const normal = branch.normals[point];
      const surfaceX = x + normal[0] * radius * .32, surfaceY = y + normal[1] * radius * .32;
      return [`M${surfaceX.toFixed(2)} ${surfaceY.toFixed(2)}l-2-2m2 2 2-1`];
    }).join(" ");
    // Leave the branch's root seam open against the trunk instead of outlining
    // a capped pipe end. Its complete filled silhouette still drives collision.
    const contour = front ? `M${branch.polygon.slice(0, -9).map(point => point.join(" ")).join("L")}` : branch.path || cactusPath(branch.polygon);
    return `<g class="cactus-tube"><defs><path id="${id}-shape" d="${branch.path || cactusPath(branch.polygon)}"/>
      <clipPath id="${id}-clip"><use href="#${id}-shape"/></clipPath></defs>
      <use href="#${id}-shape" fill="url(#${prefix}-skin)"/>
      <path d="${contour}" fill="none" stroke="${front ? "#36563d" : "#586d4b"}" stroke-width="1.8" stroke-linejoin="round"/>
      <g clip-path="url(#${id}-clip)">
        <path d="${ribbon(-1, -.53)}" fill="#244f3e" opacity=".23"/>
        <path d="${ribbon(.27, .73)}" fill="#e4e3a8" opacity="${front ? ".33" : ".25"}"/>
        ${ribs}<path d="${spines}" fill="none" stroke="#ece5b5" stroke-width="1" stroke-linecap="round" opacity=".82"/>
      </g></g>`;
  };
  const gradient = `<defs><linearGradient id="${prefix}-skin" x1=".12" y1="0" x2=".9" y2=".8">
    <stop stop-color="${front ? "#c0d28c" : "#bcc68c"}"/><stop offset=".35" stop-color="${front ? "#8caf65" : "#99ae72"}"/>
    <stop offset=".68" stop-color="${front ? "#6a9358" : "#7d965f"}"/><stop offset="1" stop-color="${front ? "#4a744c" : "#607b54"}"/>
    </linearGradient></defs>`;
  const root = `<g class="cactus-roots" data-ground-y="${design.rootY}">
    <ellipse class="cactus-contact-shadow" cx="234" cy="270" rx="37" ry="7" fill="#795c3d" opacity=".32"/>
    <path class="cactus-sand-mound" d="M192 270q12-11 27-10l15-4 16 5q14 1 23 12-37 11-81-3Z" fill="#e6bf86"/>
    <path d="M211 261q-6 7-15 9m24-8q-1 7-7 11m34-13q7 9 18 11m-31-8 5 12" fill="none" stroke="#536d46" stroke-width="5" stroke-linecap="round"/>
    <path d="M212 260q-6 7-14 9m24-8-5 10m30-10q7 7 15 9" fill="none" stroke="#b5bb7e" stroke-width="1.5" stroke-linecap="round"/>
    <!-- Foreground sand occludes the rounded trunk cap and root ends. -->
    <path class="cactus-buried-base" d="m192 272 15-4 11 3 13-4 14 4 14-2 15 5q-37 9-82-2Z" fill="#edc78f"/>
    <ellipse cx="234" cy="267" rx="24" ry="3" fill="#665539" opacity=".28"/>
    <path d="m201 274 14-1m27 0 13 2" stroke="#ffe2ab" stroke-width="2" stroke-linecap="round"/>
    <use href="#env-rocks" x="190" y="260" width="29" height="14"/>
    <use href="#env-rocks" x="251" y="264" width="22" height="11"/>
    <path d="m197 278 14-1m39 0 14-2" stroke="#bd9767" stroke-width="1.4" stroke-linecap="round"/>
    </g>`;
  const content = front ? design.branches.map(skin).join("") : `
    <g class="cactus-cast-shadow" fill="#665d3b">
      <path d="M231 266q-33 10-73 17L36 291q-19 6 3 9l137-6q44-10 76-23Z" opacity=".12"/>
      <ellipse cx="130" cy="293" rx="112" ry="7" opacity=".10"/>
      <ellipse cx="135" cy="292" rx="91" ry="3.5" opacity=".08"/></g>
    ${design.rear.map(skin).join("")}${skin(design.trunk, "trunk")}
    <path d="M217 160q-5 11 1 23m4-18q-5 9-2 15" fill="none" stroke="#355c41" stroke-opacity=".32" stroke-width="4" stroke-linecap="round"/>
    ${root}`;
  return `<svg class="obstacle-art ${front ? "obstacle-crossing cactus-branches" : "obstacle-supports cactus-roadside"}" viewBox="0 0 272 300">${gradient}${content}</svg>`;
}

function naturalObstacleArt(object) {
  const id = `natural-${object.kind}-${object.id}`;
  if (object.kind === "boulder") {
    const top = CHUG_BOULDERS[object.variant].top;
    const outline = `M10 112 18 80 ${top.map(point => point.join(" ")).join(" ")} 230 114 218 120 26 120Z`;
    const cap = `M${top.map(point => point.join(" ")).join(" ")} ${top.slice().reverse().map(([x, y]) => `${x} ${y + 13}`).join(" ")}Z`;
    const colors = [["#e8b081", "#bb7e58"], ["#dfad83", "#b77d60"], ["#e6b791", "#bd8867"]][object.variant];
    return `<svg class="obstacle-art natural-art" viewBox="0 0 240 120" preserveAspectRatio="none">
      <defs><linearGradient id="${id}-stone" x1=".2" y1="0" x2=".7" y2="1"><stop stop-color="${colors[0]}"/><stop offset="1" stop-color="${colors[1]}"/></linearGradient>
      <path id="${id}-outline" d="${outline}"/><clipPath id="${id}-clip"><use href="#${id}-outline"/></clipPath></defs>
      <ellipse cx="121" cy="116" rx="109" ry="4" fill="#704c34" opacity=".24"/>
      <use href="#${id}-outline" fill="url(#${id}-stone)" stroke="#93694f" stroke-width="2" stroke-linejoin="round"/>
      <g clip-path="url(#${id}-clip)">
        <path d="M160 20 176 55 161 81 180 113 231 119V50Z" fill="#94644f" opacity=".2"/>
        <path d="M18 83 47 97 97 91 131 108 181 113 215 105 237 117V126H5Z" fill="#a77355" opacity=".22"/>
        <path d="${cap}" fill="#ffe0ac" opacity=".32"/>
        <path d="m37 62 26 4 25-5m19 18 34 3 19-4m-132 23 30 4 15-3m102-46 30 6m-87-10 30 2" fill="none" stroke="#f8cda0" stroke-width="2" stroke-linecap="round" opacity=".55"/>
        <path d="m73 35 7 16-8 11 7 12m1-23 13 4m43 32-9 12 4 13m52-29 10 12-2 8" fill="none" stroke="#91634e" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" opacity=".5"/>
        <path d="m75 35 8 14m-45 58 15 2m125-73 9 10" fill="none" stroke="#ffe2b6" stroke-width="1.4" stroke-linecap="round" opacity=".5"/>
      </g></svg>`;
  }
  const pads = CHUG_PRICKLY_PEARS[object.variant].pads;
  const greens = [["#a6bc79", "#658e5b", "#487551"], ["#9bb67c", "#73965e", "#4d7957"], ["#b0bd7c", "#7d9d67", "#547c56"]];
  const gradients = greens.map(([light, mid, dark], index) => `<linearGradient id="${id}-pad-${index}" x1="0" y1=".2" x2="1" y2=".7"><stop stop-color="${light}"/><stop offset=".55" stop-color="${mid}"/><stop offset="1" stop-color="${dark}"/></linearGradient>`).join("");
  const padArt = pads.map(([cx, cy, rx, ry], index) => {
    const spines = [-2.65, -1.8, -.9, -.1, .75, 2.15, 3].map(angle => {
      const x = cx + Math.cos(angle) * rx, y = cy + Math.sin(angle) * ry;
      return `M${x.toFixed(2)} ${y.toFixed(2)}l${(Math.cos(angle) * 3.5).toFixed(2)} ${(Math.sin(angle) * 3.5).toFixed(2)}`;
    }).join(" ");
    return `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="url(#${id}-pad-${index % 3})" stroke="#3e6549" stroke-width="2"/>
      <path d="M${cx - rx * .5} ${cy + ry * .28}q${-rx * .2} ${-ry * .65} ${rx * .22} ${-ry * .87}" fill="none" stroke="#d0d397" stroke-width="1.8" stroke-linecap="round" opacity=".55"/>
      <path d="${spines}" fill="none" stroke="#ede0b0" stroke-width="1.1" stroke-linecap="round"/>
      <g fill="#d9d8a2" stroke="#e9dfb1" stroke-width=".7"><path d="m${cx - 4} ${cy - 8}-2-2m2 2 2-1m3 14-2-2m2 2 2-1m3-2-1-2"/><circle cx="${cx - 4}" cy="${cy - 8}" r=".9"/><circle cx="${cx - 1}" cy="${cy + 6}" r=".9"/><circle cx="${cx + 5}" cy="${cy + 4}" r=".8"/></g>`;
  }).join("");
  const highest = pads.reduce((a, b) => a[1] - a[3] < b[1] - b[3] ? a : b);
  return `<svg class="obstacle-art natural-art" viewBox="0 0 140 140" preserveAspectRatio="none"><defs>${gradients}</defs>
    <ellipse cx="70" cy="137" rx="46" ry="3" fill="#704c34" opacity=".23"/>
    <path d="M49 139q20-11 39 0" fill="#cca16d"/>${padArt}
    <g fill="#d99079" stroke="#a96b5b" stroke-width=".8"><ellipse cx="${highest[0] - 5}" cy="${highest[1] - highest[3] + 1}" rx="3" ry="4"/><ellipse cx="${highest[0] + 4}" cy="${highest[1] - highest[3] - 1}" rx="3" ry="4"/></g></svg>`;
}

const CHUG_EAGLE = Object.freeze({
  easy: { first: 42, interval: 32, warning: 1.9 },
  normal: { first: 30, interval: 24, warning: 1.5 },
  hard: { first: 24, interval: 18, warning: 1.2 }
});

// Original Bateleur rig: broad jointed wings, short tail, red bare face/feet.
// Presentation consumes the simulation clock; it adds no animation timers.
function createEagleArt(document) {
  const make = (tag, attrs, parent) => {
    const node = document.createElementNS("http://www.w3.org/2000/svg", tag);
    for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
    parent?.append(node); return node;
  };
  const svg = make("svg", { viewBox: "0 0 180 130", width: "180", height: "130", "aria-hidden": "true" });
  const bank = make("g", {}, svg);
  const wing = (far) => {
    const hinge = make("g", {}, bank), elbow = make("g", {}, hinge);
    make("path", { d: "M0 0Q4-22 30-28L42-16 26 6Q12 12 0 0Z", fill: far ? "#493f36" : "#352f29", stroke: "#252629", "stroke-width": 2 }, elbow);
    const wrist = make("g", {}, elbow);
    make("path", { d: "M28-26Q43-42 62-42L78-40 65-33 81-31 67-24 80-20 64-15 75-8 58-7 65 0 49-3 51 5Q32 9 22-2Z", fill: far ? "#625548" : "#27292a", stroke: "#242629", "stroke-width": 1.6, "stroke-linejoin": "round" }, wrist);
    make("path", { d: "M31-24Q47-34 62-34L52-26 66-27 53-18 65-18 51-11 59-9 43-5 46 0 28-5Z", fill: far ? "#b3a58c" : "#c8bba0" }, wrist);
    make("path", { d: "M40-28 32-8m11-17-6 17m15-16-8 17m16-15-10 15", fill: "none", stroke: "#6c6254", "stroke-width": 1.2 }, wrist);
    make("path", { d: "M4-3Q11-18 29-20M10 2 24-12", fill: "none", stroke: "#86745d", "stroke-width": 2, "stroke-linecap": "round" }, elbow);
    return { hinge, elbow, wrist };
  };
  const far = wing(true);
  make("path", { d: "M108 61 134 58 130 70 114 76Z", fill: "#9a7250", stroke: "#28292a", "stroke-width": 2 }, bank);
  make("path", { d: "M64 59Q77 44 102 52Q123 57 115 73Q100 88 78 77L60 70Z", fill: "#2c2927", stroke: "#22272a", "stroke-width": 2 }, bank);
  make("path", { d: "M82 54Q100 49 110 60L92 67Z", fill: "#73533d" }, bank);
  const legs = [0, 1].map(index => make("path", { fill: "none", stroke: index ? "#ee573b" : "#b8382c", "stroke-width": 4, "stroke-linecap": "round", "stroke-linejoin": "round" }, bank));
  const claws = [0, 1].map(() => make("path", { fill: "none", stroke: "#f1d59c", "stroke-width": 1.8, "stroke-linecap": "round" }, bank));
  const near = wing(false);
  make("path", { d: "M77 57Q76 43 65 43Q51 42 48 54L51 65 66 69Z", fill: "#24272a", stroke: "#20272a", "stroke-width": 2 }, bank);
  make("path", { d: "M53 48Q44 49 45 58L52 64 63 59 64 49Z", fill: "#e34d35" }, bank);
  make("path", { d: "M46 52Q34 51 31 58L36 59 36 65Q43 66 48 57Z", fill: "#e0bb68", stroke: "#3b322a", "stroke-width": 1.5 }, bank);
  make("path", { d: "m34 57-3 1 5 1v6q5-1 6-5", fill: "#403a32" }, bank);
  make("circle", { cx: 54, cy: 52, r: 2.3, fill: "#f6d282" }, bank);
  make("circle", { cx: 53.5, cy: 52, r: 1.3, fill: "#1e2528" }, bank);
  make("path", { d: "m49 48 10-1", stroke: "#1d2529", "stroke-width": 2 }, bank);
  const warning = make("g", {}, svg);
  make("path", { d: "M16 7h148v21H16Z", fill: "#f3d443", stroke: "#303235", "stroke-width": 2 }, warning);
  const label = make("text", { x: 90, y: 22, "text-anchor": "middle", fill: "#24292c", "font-size": 12, "font-family": "Segoe UI, Arial, sans-serif", "font-weight": 900 }, warning);
  label.textContent = "EAGLE! SLIDE / MOVE";
  return { svg, update(bird, reduced = false) {
    bank.setAttribute("transform", `rotate(${bird.bank} 90 65)${bird.facingRight ? " translate(180 0) scale(-1 1)" : ""}`);
    const beat = Math.sin(bird.age * 8), amplitude = reduced ? 0 : bird.flap;
    for (const [index, part] of [far, near].entries()) {
      part.hinge.setAttribute("transform", `translate(${index ? 98 : 87} 61) scale(${index ? 1 : -.86} ${index ? 1 : .86})`);
      part.elbow.setAttribute("transform", `rotate(${-14 + beat * amplitude - bird.talons * 8})`);
      part.wrist.setAttribute("transform", `rotate(${Math.sin(bird.age * 8 - .65) * amplitude * .65 + bird.talons * 12} 30 -18)`);
    }
    legs.forEach((leg, index) => {
      const x = 84 + index * 13, reach = bird.talons;
      const footX = x - 8 - reach * 16, footY = 81 + reach * 23;
      leg.setAttribute("d", `M${x} 73l${3 - reach * 9} ${5 + reach * 8}L${footX} ${footY}l-7 1m7-1 2 5m-2-5 8 2`);
      claws[index].setAttribute("d", `M${footX - 7} ${footY + 1}q-2 2 0 4m9 0q-1 3-3 3m9-5q2 2 0 4`);
    });
    warning.setAttribute("display", bird.phase === "warn" ? "inline" : "none");
  } };
}

class ChugChugEngine {
  constructor(random = Math.random, tankStorage = null) {
    this.random = random;
    this.tankStorage = tankStorage;
    this.communityWater = 0;
    try {
      const saved = Number(tankStorage?.getItem(COMMUNITY_TANK_KEY));
      if (Number.isFinite(saved)) this.communityWater = Math.max(0, Math.min(CHUG_RULES.tankCapacity, Math.floor(saved)));
    } catch { /* Storage can be unavailable; the tank still works for this page. */ }
    this.width = 1120;
    this.cameraX = 0;
    this.playerX = 78;
    this.difficulty = "normal";
    this.reset();
  }

  reset(status = "ready") {
    this.cameraX = 0;
    this.followScreenX = this.startingPosition();
    this.playerWorldX = this.followScreenX;
    this.state = {
      status, hearts: 3, score: 0, water: 0, deposited: 0, sips: 0,
      elapsed: 0, traveled: 0, distance: 0, difficulty: this.difficulty, level: 1,
      speed: this.baseSpeed(), targetSpeed: this.baseSpeed(),
      cameraSpeed: this.baseSpeed(), cameraBoost: 0,
      behindDistance: 0, behindElapsed: 0, recoveryRemaining: CHUG_RULES.recoverySeconds, endReason: null,
      jumpY: 0, velocity: 0, jumpCount: 0, jumpGravity: CHUG_RULES.gravity,
      sliding: false, slideProgress: 0, platformId: null,
      invulnerable: 0, damageFlash: 0, sipGlow: 0
    };
    this.clearInput();
    this.objects = [];
    this.effects = [];
    this.events = [];
    this.eagle = null;
    this.eagleNumber = 0;
    this.eagleSlot = null;
    this.nextEagleAt = CHUG_EAGLE[this.difficulty].first;
    this.nextId = 1;
    this.hazardNumber = 0;
    this.hazardBag = [];
    this.lastHazard = null;
    this.lastCactusVariant = -1;
    this.nextHazardX = this.playerX + 720 * CHUG_DIFFICULTIES[this.difficulty].spacingMultiplier;
    if (status === "running") {
      // The first three drops teach collection before the first hazard arrives.
      [230, 290, 350].forEach(offset => this.addObject("water", this.playerX + offset));
      this.spawnAhead();
    }
  }

  start(difficulty = this.difficulty) {
    if (Object.hasOwn(CHUG_DIFFICULTIES, difficulty)) this.difficulty = difficulty;
    this.reset("running");
  }

  setDifficulty(difficulty) {
    if (this.state.status !== "ready" || !Object.hasOwn(CHUG_DIFFICULTIES, difficulty)) return false;
    this.difficulty = difficulty;
    this.reset();
    return true;
  }

  baseSpeed() {
    return CHUG_RULES.scrollSpeed;
  }

  maximumSpeed() {
    return Math.min(CHUG_RULES.maximumScrollSpeed, this.baseSpeed() * CHUG_RULES.maximumSpeedMultiplier);
  }

  speedForDistance(distance) {
    const level = Math.floor(distance / CHUG_RULES.levelDistance) + 1;
    return Math.min(this.maximumSpeed(), this.baseSpeed() * (1 + (level - 1) * CHUG_RULES.levelSpeedIncrease));
  }

  updateProgression() {
    const level = Math.floor(this.state.distance / CHUG_RULES.levelDistance) + 1;
    const targetSpeed = this.speedForDistance(this.state.distance);
    if (level > this.state.level) {
      this.state.level = level;
      this.events.push({ type: "level", level, speedIncreased: targetSpeed > this.state.targetSpeed });
    }
    this.state.targetSpeed = targetSpeed;
  }

  scrollMovement(dt) {
    this.updateProgression();
    const previousSpeed = this.state.speed;
    const target = this.state.targetSpeed;
    const decay = Math.exp(-CHUG_RULES.speedResponse * dt);
    this.state.speed = target + (previousSpeed - target) * decay;
    // Exact baseline displacement for automatic running and level progression.
    return target * dt + (previousSpeed - target) * (1 - decay) / CHUG_RULES.speedResponse;
  }

  get playerX() { return Math.round((this.playerWorldX - this.cameraX) * 1e9) / 1e9; }
  set playerX(x) { this.playerWorldX = this.cameraX + x; }

  get nextHazardX() { return this.nextHazardWorldX - this.cameraX; }
  set nextHazardX(x) { this.nextHazardWorldX = this.cameraX + x; }

  get followWorldX() { return this.cameraX + this.followScreenX; }

  startingPosition() {
    const minimum = CHUG_RULES.viewportInset + CHUG_RULES.maxBehindMeters / CHUG_RULES.metersPerPixel + 16;
    return Math.round(Math.min(85, Math.max(minimum, this.width * 0.07)) * 1e9) / 1e9;
  }

  moveCamera(baselineMovement, dt) {
    // Only close a positive lead. This first-order follow cannot overshoot the
    // runner or move backward to rescue them. No separate camera timer exists.
    const lead = Math.max(0, this.playerWorldX - (this.cameraX + baselineMovement + this.followScreenX + CHUG_RULES.cameraLead));
    const catchUp = Math.min(CHUG_RULES.maximumCameraBoost * dt,
      lead * -Math.expm1(-CHUG_RULES.cameraResponse * dt));
    const movement = baselineMovement + catchUp;
    this.cameraX += movement;
    this.state.cameraBoost = catchUp / dt;
    this.state.cameraSpeed = this.state.speed + this.state.cameraBoost;
    return movement;
  }

  updateRecovery(dt) {
    const state = this.state;
    const wasBehind = state.behindDistance > 0;
    const body = this.playerBounds();
    const bodyRightWorldX = this.playerWorldX + (body.x - this.playerX) + body.width;
    // cameraX is the actual left viewport boundary in world coordinates.
    // Recovery starts only after the entire collision body leaves the screen.
    const lag = Math.max(0, this.cameraX - bodyRightWorldX) * CHUG_RULES.metersPerPixel;
    // Ignore floating-point dust; automatic running advances player and camera equally.
    state.behindDistance = lag > 0.000001 ? lag : 0;
    if (state.behindDistance > 0) {
      state.behindElapsed += dt;
      state.recoveryRemaining = Math.max(0, CHUG_RULES.recoverySeconds - state.behindElapsed);
      if (!wasBehind) this.events.push({ type: "behind" });
      if (state.behindDistance >= CHUG_RULES.maxBehindMeters - 1e-9) this.endRun("fell-behind");
      else if (state.behindElapsed >= CHUG_RULES.recoverySeconds - 1e-9) {
        state.behindElapsed = CHUG_RULES.recoverySeconds;
        state.recoveryRemaining = 0;
        this.endRun("fell-behind");
      }
    } else {
      state.behindElapsed = 0;
      state.recoveryRemaining = CHUG_RULES.recoverySeconds;
      if (wasBehind) this.events.push({ type: "recovered" });
    }
  }

  endRun(reason) {
    if (this.state.status !== "running") return false;
    this.state.status = "ended";
    this.state.endReason = reason;
    this.clearInput();
    this.events.push({ type: "ended", reason });
    return true;
  }

  spawningSpeed(x) {
    // Reserve space for levels that can begin before queued obstacles arrive.
    const ahead = Math.max(this.width, x) + 750;
    return Math.max(this.state.speed, this.speedForDistance(this.state.distance + ahead * CHUG_RULES.metersPerPixel));
  }

  hazardSeparation(object, speed) {
    const difficulty = CHUG_DIFFICULTIES[this.difficulty];
    const doubleFlight = CHUG_RULES.jumpAirtime + CHUG_RULES.doubleJumpAirtime;
    const original = Math.max(object.width + CHUG_RULES.hazardGap, speed * (doubleFlight + CHUG_RULES.hazardRecovery));
    // Even when advancing with D, leave time to react and complete the duck.
    const clearGap = Math.max(CHUG_RULES.hazardGap * difficulty.spacingMultiplier,
      (speed + CHUG_RULES.horizontalSpeed) * (difficulty.reactionTime + CHUG_RULES.slideDuration));
    return Math.max(original * difficulty.spacingMultiplier, object.width + clearGap, speed * (doubleFlight + 0.3));
  }

  setViewport(width) {
    this.width = Math.max(300, width);
    if (this.state.status === "ready") {
      this.followScreenX = this.startingPosition();
      this.playerX = this.followScreenX;
    }
    this.clampPlayer();
    if (this.state.status === "running") this.spawnAhead();
  }

  clampPlayer() {
    this.playerX = Math.min(this.width - CHUG_RULES.runnerWidth - CHUG_RULES.viewportInset, this.playerX);
  }

  clearInput() {
    this.input = { left: false, right: false, slide: false };
  }

  setInput(action, pressed) {
    if (Object.hasOwn(this.input, action) && (!pressed || this.state.status === "running")) this.input[action] = Boolean(pressed);
  }

  jump() {
    if (this.state.status !== "running" || this.state.jumpCount >= 2) return false;
    if (this.state.slideProgress > 0 && this.standingBlocked()) return false;
    this.state.sliding = false;
    this.state.slideProgress = 0;
    if (this.state.jumpCount === 0) {
      this.state.jumpGravity = CHUG_RULES.gravity;
      this.state.velocity = CHUG_RULES.jumpImpulse;
      if (this.state.jumpY > 0) {
        // An elevated takeoff keeps the existing gravity and two jumps, while
        // respecting the same headroom that bounds jumps from the desert floor.
        this.state.velocity = Math.min(this.state.velocity,
          Math.sqrt(2 * CHUG_RULES.gravity * Math.max(0, CHUG_RULES.maxJumpHeight - this.state.jumpY)
            * CHUG_RULES.jumpHeight / CHUG_RULES.maxJumpHeight));
      }
    } else {
      const headroom = CHUG_RULES.maxJumpHeight - this.state.jumpY;
      if (headroom <= 0) return false;
      // Preserve the boost's safe apex and upward impulse. Stronger falling
      // gravity shortens its descent within the existing 1.35s flight budget.
      const targetGravity = 2 * (Math.sqrt(headroom) + Math.sqrt(CHUG_RULES.maxJumpHeight)) ** 2
        / CHUG_RULES.doubleJumpAirtime ** 2;
      const risingVelocity = Math.max(0, this.state.velocity);
      // An early second press must never brake the current ascent. Increasing
      // gravity above the target when needed keeps that velocity safely in view.
      this.state.jumpGravity = Math.max(targetGravity, risingVelocity ** 2 / (2 * headroom));
      this.state.velocity = Math.sqrt(2 * this.state.jumpGravity * headroom);
    }
    this.state.jumpCount += 1;
    this.state.platformId = null;
    return true;
  }

  verticalGravity() {
    return this.state.jumpGravity * (this.state.velocity <= 0 ? CHUG_RULES.fallGravityMultiplier : 1);
  }

  updateJump(dt) {
    const state = this.state;
    if (state.platformId !== null || (state.jumpY === 0 && state.velocity === 0)) return;
    // Integrate exactly to the apex before switching gravity, even when it
    // falls between physics steps. Position and velocity stay continuous.
    const ascentTime = state.velocity > 0 ? Math.min(dt, state.velocity / state.jumpGravity) : 0;
    state.jumpY += state.velocity * ascentTime - 0.5 * state.jumpGravity * ascentTime ** 2;
    state.velocity -= state.jumpGravity * ascentTime;
    const fallTime = dt - ascentTime;
    if (fallTime > 0) {
      const gravity = state.jumpGravity * CHUG_RULES.fallGravityMultiplier;
      state.jumpY += state.velocity * fallTime - 0.5 * gravity * fallTime ** 2;
      state.velocity -= gravity * fallTime;
    }
    if (state.jumpY <= 0) {
      state.jumpY = 0;
      state.velocity = 0;
      state.jumpCount = 0;
      state.jumpGravity = CHUG_RULES.gravity;
    }
  }

  pause() {
    if (this.state.status !== "running") return false;
    this.state.status = "paused";
    this.clearInput();
    return true;
  }

  resume() {
    if (this.state.status !== "paused") return false;
    this.state.status = "running";
    return true;
  }

  addObject(kind, x, y, options = {}) {
    const variants = kind === "boulder" ? CHUG_BOULDERS : kind === "prickly-pear" ? CHUG_PRICKLY_PEARS : kind === "cactus-overhead" ? CHUG_CACTI : null;
    const variant = variants ? (Number.isInteger(options.variant) ? Math.abs(options.variant) % variants.length : Math.floor(this.random() * variants.length)) : options.variant ?? "sign";
    const size = kind === "cactus-overhead" ? CHUG_HAZARDS[kind] : variants ? variants[variant] : kind === "water" ? { width: 40, height: 52 } : CHUG_HAZARDS[kind];
    if (!size) throw new RangeError(`Unknown object kind: ${kind}`);
    const object = {
      id: this.nextId++, kind, worldX: this.cameraX + x,
      y: y ?? CHUG_RULES.groundY - (kind === "water" ? 70 : size.height),
      width: kind === "spill" && options.wide ? 320 : size.width,
      height: size.height,
      wide: kind === "spill" && Boolean(options.wide),
      variant,
      phase: options.phase ?? 0,
      removed: false, hit: false
    };
    // Screen coordinates are a view of world position, never a second movement.
    Object.defineProperty(object, "x", {
      enumerable: true,
      get: () => object.worldX - this.cameraX,
      set: value => { object.worldX = this.cameraX + value; }
    });
    this.objects.push(object);
    return object;
  }

  nextHazard() {
    // Teach one action at a time, then shuffle a bag so every hazard gets a turn.
    const introduction = this.difficulty === "easy"
      ? ["barrel", "spill", "cactus", "cactus-overhead", "barrier", "vent", "boulder", "prickly-pear"]
      : ["barrel", "spill", "cactus-overhead", "barrier", "vent", "wide-spill", "cactus", "boulder", "prickly-pear"];
    if (this.hazardNumber < introduction.length) return introduction[this.hazardNumber];
    if (!this.hazardBag.length) {
      this.hazardBag = [...introduction, ...(this.difficulty === "hard"
        ? ["wide-spill", "vent", "cactus-overhead", "boulder", "prickly-pear"] : [])];
      for (let index = this.hazardBag.length - 1; index > 0; index -= 1) {
        const other = Math.floor(this.random() * (index + 1));
        [this.hazardBag[index], this.hazardBag[other]] = [this.hazardBag[other], this.hazardBag[index]];
      }
      if (this.hazardBag.at(-1) === this.lastHazard) this.hazardBag.reverse();
    }
    return this.hazardBag.pop();
  }

  spawnAhead() {
    // Each pattern is attached to the scrolling world, never the player's movement.
    while (this.nextHazardX < this.width + 750) {
      const x = this.nextHazardX;
      const pattern = this.nextHazard();
      const kind = pattern === "wide-spill" ? "spill" : pattern;
      const object = this.addObject(kind, x, undefined, {
        wide: pattern === "wide-spill",
        variant: kind === "boulder" || kind === "prickly-pear" || kind === "cactus-overhead"
          ? this.difficulty === "easy" ? 0 : Math.floor(this.random() * 3) : this.random() < 0.5 ? "sign" : "pipe",
        phase: this.random() * (CHUG_RULES.ventInactive + CHUG_RULES.ventWarning + CHUG_RULES.ventActive)
      });
      if (kind === "cactus-overhead") {
        if (this.difficulty !== "easy" && object.variant === this.lastCactusVariant) object.variant = (object.variant + 1) % CHUG_CACTI.length;
        this.lastCactusVariant = object.variant;
      }
      this.addObject("water", x - 230);
      this.addObject("water", x - 170);
      if (this.isOverhead(object)) {
        [15, 75, 135].forEach(offset => this.addObject("water", x + offset, CHUG_RULES.groundY - 58));
      } else {
        this.addObject("water", x + 5, CHUG_RULES.groundY - 225);
        if (object.wide) {
          [105, 205].forEach(offset => this.addObject("water", x + offset, CHUG_RULES.groundY - 225));
        } else if (kind === "barrel") this.addObject("water", x + 65, CHUG_RULES.groundY - 205);
      }
      this.addObject("water", x + object.width + 80);
      this.lastHazard = pattern;
      this.hazardNumber += 1;
      const separation = this.hazardSeparation(object, this.spawningSpeed(x));
      this.nextHazardX += separation + this.random() * 140 * CHUG_DIFFICULTIES[this.difficulty].spacingMultiplier;
    }
  }

  isOverhead(object) {
    return object.kind === "cactus-overhead" || object.kind === "barrier";
  }

  overhangLayout(object) {
    return object.kind === "cactus-overhead" ? CHUG_CACTI[Number.isInteger(object.variant) ? object.variant : 0]
      : CHUG_OVERHANGS[object.variant === "pipe" ? "pipe" : "sign"];
  }

  playerBounds(progress = this.state.slideProgress) {
    // A forgiving body hitbox excludes the stretched hands and toes of the SVG pose.
    return {
      x: this.playerX + 62 - 16 * progress,
      y: CHUG_RULES.groundY - 126 + 46 * progress - this.state.jumpY,
      width: 50 + 52 * progress, height: 121 - 46 * progress
    };
  }

  isGrounded() {
    return this.state.velocity === 0 && (this.state.jumpY === 0 || this.state.platformId !== null);
  }

  boulderProfile(object, sides = false) {
    const top = CHUG_BOULDERS[object.variant].top;
    const points = sides ? [[10, 112], [18, 80], ...top, [230, 114]] : top;
    return points.map(([x, y]) => [object.x + x * object.width / 240, object.y + y * object.height / 120]);
  }

  boulderSurface(object, bounds = this.playerBounds(), sides = false) {
    const points = this.boulderProfile(object, sides);
    let surface = Infinity;
    for (let index = 1; index < points.length; index += 1) {
      const [ax, ay] = points[index - 1], [bx, by] = points[index];
      const left = Math.max(ax, bounds.x), right = Math.min(bx, bounds.x + bounds.width);
      if (right <= left) continue;
      const at = x => ay + (by - ay) * (x - ax) / (bx - ax);
      surface = Math.min(surface, at(left), at(right));
    }
    return Number.isFinite(surface) ? surface : null;
  }

  boulderSpan(object, bottom) {
    const points = this.boulderProfile(object, true);
    let left = Infinity, right = -Infinity;
    for (let index = 1; index < points.length; index += 1) {
      const [ax, ay] = points[index - 1], [bx, by] = points[index];
      if (Math.min(ay, by) >= bottom) continue;
      const crossing = ay === by ? ax : ax + (bx - ax) * (bottom - ay) / (by - ay);
      left = Math.min(left, ay < bottom ? ax : crossing);
      right = Math.max(right, by < bottom ? bx : crossing);
    }
    return { left, right };
  }

  landOnBoulder(object, surface) {
    this.state.platformId = object.id;
    this.state.jumpY = CHUG_RULES.groundY - surface;
    this.state.velocity = 0;
    this.state.jumpCount = 0;
    this.state.jumpGravity = CHUG_RULES.gravity;
  }

  resolveBoulders(previous, movement) {
    const rocks = this.objects.filter(object => object.kind === "boulder" && !object.removed);
    // Resolve descending crossings before considering any side contacts. The
    // previous surface uses the previous player AND scrolling rock positions.
    if (this.state.platformId === null && this.state.velocity <= 0 && previous.velocity <= 0) {
      const player = this.playerBounds();
      const feet = CHUG_RULES.groundY - this.state.jumpY;
      let landing = null;
      for (const rock of rocks) {
        const surface = this.boulderSurface(rock, player);
        if (surface === null || feet < surface - 1e-7) continue;
        const oldSurface = this.boulderSurface({ ...rock, x: rock.x + movement }, previous.bounds);
        if (previous.feet > (oldSurface ?? surface) + 1e-7) continue;
        if (!landing || surface < landing.surface) landing = { rock, surface };
      }
      if (landing) this.landOnBoulder(landing.rock, landing.surface);
    }
    for (const rock of rocks) {
      if (rock.id === this.state.platformId) continue;
      const player = this.playerBounds();
      const surface = this.boulderSurface(rock, player, true);
      if (surface === null || player.y + player.height <= surface + 1e-7 || player.y >= rock.y + rock.height) continue;
      this.damage(rock);
      // Solidity is independent of damage immunity and of rock.hit.
      const span = this.boulderSpan(rock, player.y + player.height);
      const fromLeft = previous.bounds.x + previous.bounds.width / 2 < rock.x + movement + rock.width / 2;
      const inset = player.x - this.playerX;
      // A tiny separation skin survives world-to-screen cancellation at contact.
      const target = fromLeft ? span.left - inset - player.width - 1e-6 : span.right - inset + 1e-6;
      const maximum = this.width - CHUG_RULES.runnerWidth - CHUG_RULES.viewportInset;
      this.playerX = Math.min(maximum, target);
      if (target > maximum) {
        // Resolve the right boundary along the rounded shoulder. Leftward
        // setbacks may leave the viewport and trigger off-screen recovery.
        const shoulder = this.boulderSurface(rock, this.playerBounds(), true);
        if (shoulder !== null) {
          this.state.jumpY = CHUG_RULES.groundY - shoulder;
          this.state.velocity = 0;
          this.state.jumpGravity = CHUG_RULES.gravity;
          const cap = this.boulderSurface(rock);
          if (cap !== null) this.landOnBoulder(rock, cap);
        }
      }
      if (this.state.status === "ended") break;
    }
  }

  standingBlocked() {
    const standing = this.playerBounds(0);
    const crouched = this.playerBounds(1);
    // Clearance covers the whole return pose, including the wider crouched shoulders.
    const headroom = {
      x: Math.min(standing.x, crouched.x), y: standing.y,
      width: Math.max(standing.x + standing.width, crouched.x + crouched.width) - Math.min(standing.x, crouched.x),
      height: standing.height
    };
    return this.objects.some(object => this.isOverhead(object) && !object.removed
      && this.hazardBounds(object).some(bounds => ChugChugEngine.overlaps(headroom, bounds)));
  }

  updateSlide(dt) {
    const grounded = this.isGrounded();
    this.state.sliding = grounded && (this.input.slide || this.state.slideProgress > 0 && this.standingBlocked());
    const change = dt / CHUG_RULES.slideDuration;
    this.state.slideProgress = Math.max(0, Math.min(1, this.state.slideProgress + (this.state.sliding ? change : -change)));
  }

  ventState(object) {
    const cycle = CHUG_RULES.ventInactive + CHUG_RULES.ventWarning + CHUG_RULES.ventActive;
    const remainder = (this.state.elapsed + object.phase) % cycle;
    const time = remainder < 0 ? remainder + cycle : remainder;
    if (time < CHUG_RULES.ventInactive) return "inactive";
    if (time < CHUG_RULES.ventInactive + CHUG_RULES.ventWarning) return "warning";
    return "active";
  }

  hazardBounds(object) {
    // Shapes are local to the rendered sprite; empty clearance has no hitbox.
    const rect = (x, y, width, height) => ({ x: object.x + x, y: object.y + y, width, height });
    if (object.kind === "prickly-pear") {
      return CHUG_PRICKLY_PEARS[object.variant].pads.map(([cx, cy, rx, ry]) => ({
        ...rect((cx - rx) * object.width / 140, (cy - ry) * object.height / 140,
          rx * 2 * object.width / 140, ry * 2 * object.height / 140), ellipse: true
      }));
    }
    if (object.kind === "cactus") {
      return [
        rect(42, 13, 28, 112), rect(12, 43, 36, 44), rect(66, 26, 30, 55)
      ];
    }
    if (this.isOverhead(object)) {
      if (object.kind === "cactus-overhead") {
        return this.overhangLayout(object).branches.map(branch => ({
          ...rect(branch.bounds.x, branch.bounds.y, branch.bounds.width, branch.bounds.height),
          polygon: branch.polygon, originX: object.x, originY: object.y
        }));
      }
      return this.overhangLayout(object).solids.map(([x, y, width, height, radius]) => ({
        ...rect(x, y, width, height), radius
      }));
    }
    if (object.kind === "vent") {
      // The flush grate is safe. Warning is harmless; only active vapor hurts.
      return this.ventState(object) === "active"
        ? [rect(24, 94, 64, 62), rect(34, 48, 54, 52), rect(52, 18, 26, 38)] : [];
    }
    const spill = { ...rect(4, object.height - 12, object.width - 8, 12), ellipse: true };
    if (object.kind === "spill") return [spill];
    if (object.kind === "barrel") return [rect(32, 26, 68, 110), spill];
    return [];
  }

  static overlaps(a, b) {
    if (!(a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y)) return false;
    if (b.polygon) {
      // Only the cactus uses polygon silhouettes. Work in its local coordinates
      // so cached artwork/collision vertices never need per-frame rebuilding.
      const left = a.x - b.originX, top = a.y - b.originY;
      const right = left + a.width, bottom = top + a.height;
      const cx = (left + right) / 2, cy = (top + bottom) / 2;
      let inside = false;
      for (let index = 0, last = b.polygon.length - 1; index < b.polygon.length; last = index++) {
        const [x, y] = b.polygon[index], [px, py] = b.polygon[last];
        if ((y > cy) !== (py > cy) && cx < (px - x) * (cy - y) / (py - y) + x) inside = !inside;
      }
      if (inside) return true;
      // Clip each outline segment to the open rectangle. This also handles
      // concave elbows, small branch tips and a rectangle enclosing the limb.
      for (let index = 0; index < b.polygon.length; index += 1) {
        const p = b.polygon[index], q = b.polygon[(index + 1) % b.polygon.length];
        let enter = 0, exit = 1;
        for (const [origin, delta, minimum, maximum] of [[p[0], q[0] - p[0], left, right], [p[1], q[1] - p[1], top, bottom]]) {
          if (Math.abs(delta) < 1e-10) {
            if (origin <= minimum || origin >= maximum) { exit = -1; break; }
          } else {
            const first = (minimum + 1e-8 - origin) / delta, second = (maximum - 1e-8 - origin) / delta;
            enter = Math.max(enter, Math.min(first, second));
            exit = Math.min(exit, Math.max(first, second));
          }
        }
        if (enter < exit) return true;
      }
      return false;
    }
    if (b.ellipse) {
      const rx = b.width / 2, ry = b.height / 2;
      const cx = b.x + rx, cy = b.y + ry;
      const dx = (Math.max(a.x, Math.min(cx, a.x + a.width)) - cx) / rx;
      const dy = (Math.max(a.y, Math.min(cy, a.y + a.height)) - cy) / ry;
      return dx * dx + dy * dy < 1;
    }
    if (!b.radius) return true;
    // A rounded rectangle is its inset core expanded by a circle. Test that
    // distance so empty corners of cactus arms and pipe ends cannot hurt.
    const radius = Math.min(b.radius, b.width / 2, b.height / 2);
    const dx = Math.max(b.x + radius - a.x - a.width, a.x - b.x - b.width + radius, 0);
    const dy = Math.max(b.y + radius - a.y - a.height, a.y - b.y - b.height + radius, 0);
    return dx * dx + dy * dy < radius * radius;
  }

  addEffect(text, kind, x, y) {
    this.effects.push({ id: this.nextId++, text, kind, x, y, life: 1.1 });
  }

  collect(object) {
    if (object.removed || object.kind !== "water" || this.state.status !== "running") return;
    object.removed = true;
    const state = this.state;
    state.water += 1;
    state.score += CHUG_RULES.waterScore;
    this.addEffect("+ WATER  +10", "water", this.playerX - 12, Math.max(46, this.playerBounds().y - 18));
    this.events.push({ type: "water", score: state.score });
    if (state.water % 5 === 0) {
      state.sips += 1;
      state.sipGlow = 0.65;
      this.addEffect("CHUG! AUTO SIP", "chug", this.playerX + 70, 92);
      this.events.push({ type: "chug" });
    } else if (this.communityWater < CHUG_RULES.tankCapacity) {
      const previousWater = this.communityWater;
      this.communityWater += 1;
      state.deposited += 1;
      try {
        this.tankStorage?.setItem(COMMUNITY_TANK_KEY, String(this.communityWater));
      } catch { /* Keep playing with in-memory progress if saving is blocked. */ }
      // Saved water only increases, so crossed thresholds cannot replay after a reset or reload.
      for (const percent of TANK_MILESTONES) {
        const threshold = CHUG_RULES.tankCapacity * percent / 100;
        if (previousWater < threshold && this.communityWater >= threshold) {
          const full = percent === 100;
          this.addEffect(full ? "COMMUNITY TANK FULL!" : `TANK ${percent}% FULL!`, full ? "full" : "milestone", this.playerX + 90, 65);
          this.events.push({ type: full ? "full" : "milestone", percent });
        }
      }
    }
  }

  damage(object) {
    const state = this.state;
    if (state.invulnerable > 0 || object.hit || state.status !== "running") return false;
    object.hit = true;
    const penalty = Math.min(state.score, CHUG_RULES.hazardPenalty);
    state.score = Math.max(0, state.score - CHUG_RULES.hazardPenalty);
    state.hearts -= 1;
    state.invulnerable = CHUG_RULES.invulnerability;
    state.damageFlash = CHUG_RULES.damageFlashDuration;
    this.addEffect(penalty ? `−1 HEART  −${penalty}` : "−1 HEART", "damage", this.playerX - 15, 176);
    this.events.push({ type: "damage", penalty, hearts: state.hearts, kind: object.kind });
    if (state.hearts === 0) {
      this.endRun("hearts");
    }
    return true;
  }

  beginEaglePath(phase, duration, end, velocity) {
    const bird = this.eagle;
    bird.phase = phase; bird.phaseTime = 0; bird.duration = duration;
    bird.path = [[bird.worldX, bird.y], [bird.worldX + bird.vx * duration / 3, bird.y + bird.vy * duration / 3],
      [end[0] - velocity[0] * duration / 3, end[1] - velocity[1] * duration / 3], end];
    if (phase === "warn") this.events.push({ type: "eagle-warning" });
  }

  advanceEaglePhase() {
    const b = this.eagle, speed = this.state.speed;
    const skyX = offset => this.cameraX + Math.max(10, Math.min(this.width - 190, this.playerX + offset));
    if (b.phase === "enter") this.beginEaglePath("soar", .9, [skyX(140) + speed * .9, 40], [speed - 25, 0]);
    else if (b.phase === "soar") {
      const time = CHUG_EAGLE[this.difficulty].warning;
      this.beginEaglePath("warn", time, [skyX(90) + speed * time, 60], [speed - 40, 30]);
    } else if (b.phase === "warn") {
      const body = this.playerBounds();
      // One committed world-space intercept. Subsequent directional inputs
      // never steer the bird; normal auto-running is predicted at this instant.
      b.targetWorldX = this.cameraX + body.x + body.width / 2 + speed - 80;
      this.beginEaglePath("dive", 1, [b.targetWorldX, 136], [speed - 180, 0]);
    } else if (b.phase === "dive") this.beginEaglePath("recover", 1.5, [b.worldX + speed * 1.5 - 290, -180], [speed - 160, -230]);
    else {
      this.eagle = null; this.eagleSlot = null;
      this.nextEagleAt = this.state.elapsed + CHUG_EAGLE[this.difficulty].interval;
    }
  }

  eagleBounds() {
    const b = this.eagle;
    if (!b || b.aborted || (b.phase !== "dive" && !(b.phase === "recover" && b.phaseTime < .4))) return [];
    const angle = b.bank * Math.PI / 180;
    return [[66, 50, 47, 30], [52, 81, 50, 29 * b.talons]].map(([x, y, width, height]) => {
      const polygon = [[x, y], [x + width, y], [x + width, y + height], [x, y + height]].map(([px, py]) => [b.facingRight ? 180 - px : px, py]).map(([px, py]) => [
        90 + (px - 90) * Math.cos(angle) - (py - 65) * Math.sin(angle),
        65 + (px - 90) * Math.sin(angle) + (py - 65) * Math.cos(angle)]);
      return { ...cactusBounds(polygon), x: b.worldX - this.cameraX + Math.min(...polygon.map(p => p[0])),
        y: b.y + Math.min(...polygon.map(p => p[1])), polygon, originX: b.worldX - this.cameraX, originY: b.y };
    });
  }

  updateEagle(dt, cameraCatchUp = 0) {
    // Before commitment, gliding follows the temporary camera catch-up so the
    // warning remains visible. Committed world-space attack paths never shift.
    if (this.eagle && ["enter", "soar", "warn"].includes(this.eagle.phase)) {
      this.eagle.worldX += cameraCatchUp;
      this.eagle.path.forEach(point => { point[0] += cameraCatchUp; });
    }
    if (!this.eagleSlot && !this.eagle && this.state.elapsed >= this.nextEagleAt) {
      // Reserve a clean world-space encounter after already queued obstacles.
      // No new ground obstacle can enter the full flight/reaction corridor.
      const start = Math.max(this.playerWorldX + 200,
        ...this.objects.filter(o => o.kind !== "water").map(o => o.worldX + o.width + 200));
      const duration = 1.4 + .9 + CHUG_EAGLE[this.difficulty].warning + 1 + 1.5;
      this.eagleSlot = { start, end: start + CHUG_RULES.maximumScrollSpeed * duration + 300 };
      this.nextHazardWorldX = Math.max(this.nextHazardWorldX, this.eagleSlot.end);
    }
    if (!this.eagle && this.eagleSlot && this.playerWorldX >= this.eagleSlot.start) {
      this.eagleNumber += 1;
      const skyX = this.cameraX + Math.max(10, Math.min(this.width - 190, this.playerX + 250));
      this.eagle = { id: this.nextId++, kind: "eagle", hit: false, worldX: skyX, y: -160,
        facingRight: skyX + 90 < this.playerWorldX + 87,
        vx: this.state.speed - 40, vy: 70, age: 0, bank: 0, talons: 0, flap: 18 };
      this.beginEaglePath("enter", 1.4, [skyX + this.state.speed * 1.4, 30], [this.state.speed - 35, 0]);
    }
    // A player can advance faster than the reservation's baseline. Withdraw
    // smoothly if that brings a ground obstacle into the attack corridor.
    if (this.eagle && ["warn", "dive"].includes(this.eagle.phase) && this.objects.some(o =>
      o.kind !== "water" && o.x + o.width > this.playerX + 40 && o.x < this.playerX + 160 + this.state.speed * 1.4)) {
      this.eagle.aborted = true;
      this.beginEaglePath("recover", 1.5, [this.eagle.worldX + this.state.speed - 200, -180], [this.state.speed - 160, -230]);
    }
    let remaining = dt;
    while (this.eagle && remaining > 1e-10) {
      const b = this.eagle, step = Math.min(remaining, b.duration - b.phaseTime);
      b.phaseTime += step; b.age += step; remaining -= step;
      const t = Math.min(1, b.phaseTime / b.duration), u = 1 - t, p = b.path;
      b.worldX = u ** 3 * p[0][0] + 3 * u * u * t * p[1][0] + 3 * u * t * t * p[2][0] + t ** 3 * p[3][0];
      b.y = u ** 3 * p[0][1] + 3 * u * u * t * p[1][1] + 3 * u * t * t * p[2][1] + t ** 3 * p[3][1];
      const derivative = axis => 3 * (u * u * (p[1][axis] - p[0][axis]) + 2 * u * t * (p[2][axis] - p[1][axis]) + t * t * (p[3][axis] - p[2][axis])) / b.duration;
      b.vx = derivative(0); b.vy = derivative(1);
      const blend = -Math.expm1(-step * 12);
      const bank = Math.max(-50, Math.min(50, (b.facingRight ? 1 : -1) * Math.atan2(b.vy, Math.max(100, Math.abs(this.state.speed - b.vx))) * 180 / Math.PI));
      b.bank += (bank - b.bank) * blend;
      b.talons += ((b.phase === "dive" ? 1 : b.phase === "warn" ? .35 : 0) - b.talons) * blend;
      b.flap += (({ enter: 19, soar: 3, warn: 10, dive: 2, recover: 25 }[b.phase]) - b.flap) * blend;
      if (b.phaseTime >= b.duration - 1e-9) this.advanceEaglePhase();
    }
    if (this.eagle && this.eagleBounds().some(bounds => ChugChugEngine.overlaps(this.playerBounds(), bounds))) this.damage(this.eagle);
  }

  update(dt) {
    const state = this.state;
    if (state.status !== "running" || !Number.isFinite(dt) || dt <= 0) return;
    // The browser feeds fixed 1/120-second steps; cap stray callers as well.
    dt = Math.min(dt, 0.1);
    // Match the browser's 120 Hz physics at every difficulty and caller frame rate.
    // This also bounds fast relative movement and keeps level crossings consistent.
    if (dt > 1 / 120 + 1e-9) {
      const steps = Math.ceil(dt * 120);
      for (let index = 0; index < steps && state.status === "running"; index += 1) this.update(dt / steps);
      return;
    }
    const previous = { bounds: this.playerBounds(), feet: CHUG_RULES.groundY - state.jumpY, velocity: state.velocity };
    state.elapsed += dt;
    const baselineMovement = this.scrollMovement(dt);
    const direction = Number(this.input.right) - Number(this.input.left);
    this.playerWorldX += baselineMovement + direction * CHUG_RULES.horizontalSpeed * dt;
    const movement = this.moveCamera(baselineMovement, dt);
    this.clampPlayer();
    // Baseline distance controls levels; temporary catch-up never raises difficulty.
    state.traveled += baselineMovement;
    state.distance = state.traveled * CHUG_RULES.metersPerPixel;
    this.updateProgression();
    // Snap only numerical residue to zero so the 3s boundary is not delayed a step.
    state.invulnerable = state.invulnerable <= dt + 1e-9 ? 0 : state.invulnerable - dt;
    state.damageFlash = state.damageFlash <= dt + 1e-9 ? 0 : state.damageFlash - dt;
    state.sipGlow = Math.max(0, state.sipGlow - dt);

    const wasSupported = state.platformId !== null;
    // A slide changes the horizontal footprint. Solve its pose before following
    // the cap so both use the same footprint and cannot introduce a foot gap.
    if (wasSupported) this.updateSlide(dt);
    if (state.platformId !== null) {
      const support = this.objects.find(object => object.id === state.platformId && object.kind === "boulder" && !object.removed);
      const surface = support ? this.boulderSurface(support) : null;
      if (surface === null) {
        state.platformId = null;
        state.jumpGravity = CHUG_RULES.gravity;
      } else this.landOnBoulder(support, surface);
    }
    this.updateJump(dt);

    if (!wasSupported) this.updateSlide(dt);
    this.resolveBoulders(previous, movement);

    this.effects.forEach(effect => { effect.life -= dt; effect.y -= 30 * dt; });
    this.effects = this.effects.filter(effect => effect.life > 0);
    const player = this.playerBounds();
    for (const object of this.objects) {
      if (object.removed || object.x + object.width < 0) continue;
      if (object.kind === "water") {
        // A rectangle inside the droplet avoids collecting empty SVG corners.
        const water = { x: object.x + 6, y: object.y + 9, width: 28, height: 39 };
        if (ChugChugEngine.overlaps(player, water)) this.collect(object);
      } else if (object.kind !== "boulder" && this.hazardBounds(object).some(bounds => ChugChugEngine.overlaps(player, bounds))) {
        this.damage(object);
        if (state.status === "ended") break;
      }
    }
    this.objects = this.objects.filter(object => !object.removed && object.x + object.width > -30);
    if (state.status === "running") this.updateRecovery(dt);
    if (state.status === "running") this.updateEagle(dt, movement - baselineMovement);
    if (state.status === "running") this.spawnAhead();
  }

  drainEvents() {
    const events = this.events;
    this.events = [];
    return events;
  }
}

// No import/fetch is needed: the game also works by opening index.html directly.
if (typeof module !== "undefined" && module.exports) module.exports = { ChugChugEngine, CHUG_RULES, CHUG_DIFFICULTIES, CHUG_HAZARDS, CHUG_OVERHANGS, COMMUNITY_TANK_KEY, CHUG_BOULDERS, CHUG_PRICKLY_PEARS, naturalObstacleArt, CHUG_CACTI, cactusObstacleArt, CHUG_EAGLE, createEagleArt };

if (typeof document !== "undefined") {
  (() => {
    const byId = id => document.getElementById(id);
    let tankStorage = null;
    try { tankStorage = window.localStorage; } catch { /* Some browsers block local storage. */ }
    const engine = new ChugChugEngine(Math.random, tankStorage);
    const difficultyButtons = Object.fromEntries(Object.keys(CHUG_DIFFICULTIES).map(mode => [mode, byId(`difficulty-${mode}`)]));
    const levelAnnouncement = byId("level-announcement");
    let levelAnnouncementUntil = 0;
    const sound = new ChugGameFeedback.SoundEffects({ AudioContext: window.AudioContext || window.webkitAudioContext, storage: tankStorage });
    const soundButton = byId("sound-button");
    const scoreMilestones = new ChugGameFeedback.ScoreMilestones();
    const scoreMilestone = byId("score-milestone");
    const pendingScoreMilestones = [];
    let scoreMilestoneUntil = 0;
    const screens = { start: byId("start-screen"), game: byId("game-screen"), results: byId("results-screen") };
    const world = byId("world");
    const scene = byId("scene");
    const runner = byId("runner");
    const message = byId("run-message");
    const announcer = byId("announcer");
    const pauseOverlay = byId("pause-overlay");
    const jumpButton = byId("jump-button");
    const holdButtons = { left: byId("left-button"), right: byId("right-button"), slide: byId("slide-button") };
    const controlButtons = [...Object.values(holdButtons), jumpButton];
    const heldKeys = new Set();
    const heldPointers = new Map();
    const heldButtons = new Set();
    const keyActions = { KeyA: "left", ArrowLeft: "left", KeyD: "right", ArrowRight: "right", KeyS: "slide", ArrowDown: "slide" };
    const pauseButton = byId("pause-button");
    const sprites = new Map();
    let eagleSprite = null;
    const feedback = new Map();
    // Decorative layers follow the same camera as collisions and pickups; resizing
    // stay in sync with the existing game loop without extra animation timers.
    const sceneryTileWidth = 1600;
    const sceneryLayers = [
      ["clouds", 0.035], ["mountains", 0.08], ["mesas", 0.17],
      ["village", 0.25], ["dunes", 0.34], ["plants", 0.52], ["cracks", 1.04]
    ].map(([id, speed]) => ({ element: byId(id), speed }));
    // A separate seeded scenery stream leaves the engine's hazard RNG untouched.
    let boneSeed = Date.now() >>> 0;
    const boneTypes = ["cattle-skull", "rib-cage", "scattered-bones", "spine", "partial-remains"];
    const boneLayers = [
      { element: byId("bones-midground"), speed: 0.52, height: 48, scale: 0.78, salt: 0x73a1, tiles: new Map() },
      { element: byId("bones-foreground"), speed: 1.04, height: 56, scale: 1, salt: 0xb95f, tiles: new Map() }
    ];
    const trackPebbles = byId("pebbles");
    const confetti = byId("tank-confetti");
    let celebrationUntil = 0;
    let frameId = null;
    let previousTime = null;
    let accumulator = 0;
    let messageUntil = 3.6;
    let messageKind = "";
    let currentScreen = "start";

    // Keep the original crouch art; the running rig articulates fixed-length bones.
    const originalRunner = byId("runner-art");
    const animatedRunner = byId("animated-runner");
    const originalParts = Array.from(originalRunner.children);
    const svgNS = "http://www.w3.org/2000/svg";
    const rearLeg = document.createElementNS(svgNS, "g");
    const frontLeg = document.createElementNS(svgNS, "g");
    const upperBody = document.createElementNS(svgNS, "g");
    rearLeg.setAttribute("class", "rear-leg");
    frontLeg.setAttribute("class", "front-leg");
    upperBody.setAttribute("id", "runner-upper-body");
    [0, 1, 3].forEach(index => rearLeg.append(originalParts[index].cloneNode(true)));
    [2, 4].forEach(index => frontLeg.append(originalParts[index].cloneNode(true)));
    animatedRunner.append(rearLeg, frontLeg);
    originalParts.slice(5).forEach(part => upperBody.append(part.cloneNode(true)));
    const motionPreference = window.matchMedia?.("(prefers-reduced-motion: reduce)");
    const runnerAnimation = globalThis.ChugRunnerAnimation.create({
      document, svg: animatedRunner, upperBody, rearLeg, frontLeg, originalParts,
      reducedMotion: () => motionPreference?.matches || false
    });
    animatedRunner.append(upperBody);
    let lastPose = -1;

    function setRunnerPose(progress) {
      if (progress === lastPose) return;
      lastPose = progress;
      const mix = (start, end) => start + (end - start) * progress;
      // Bend both knees and lean the intact torso/backpack/tube assembly.
      upperBody.setAttribute("transform", `translate(${-15 * progress} ${40 * progress}) rotate(${35 * progress} 95 132)`);
      rearLeg.children[0].setAttribute("d", progress === 0 ? originalParts[0].getAttribute("d") : `M${mix(93, 80)} ${mix(132, 171)} 42 ${mix(174, 150)}`);
      rearLeg.children[1].setAttribute("d", progress === 0 ? originalParts[1].getAttribute("d") : `M42 ${mix(174, 150)} ${mix(15, 34)} ${mix(145, 165)}`);
      frontLeg.children[0].setAttribute("d", progress === 0 ? originalParts[2].getAttribute("d") : `M${mix(94, 80)} ${mix(133, 171)} ${mix(149, 121)} ${mix(101, 150)} 160 164`);
      rearLeg.children[2].setAttribute("transform", `translate(${19 * progress} ${20 * progress}) rotate(${55 * progress} 15 145)`);
    }

    function syncInputs() {
      for (const action of Object.keys(holdButtons)) {
        const down = Array.from(heldKeys).some(code => keyActions[code] === action)
          || Array.from(heldPointers.values()).includes(action) || heldButtons.has(action);
        engine.setInput(action, down);
      }
    }

    function clearControls() {
      heldKeys.clear();
      heldPointers.clear();
      heldButtons.clear();
      engine.clearInput();
    }

    function releasePointer(event) {
      if (heldPointers.delete(event.pointerId)) syncInputs();
    }

    for (const [action, button] of Object.entries(holdButtons)) {
      button.addEventListener("pointerdown", event => {
        if (engine.state.status !== "running" || event.pointerType === "mouse" && event.button !== 0) return;
        event.preventDefault();
        heldPointers.set(event.pointerId, action);
        button.setPointerCapture?.(event.pointerId);
        syncInputs();
      });
      ["pointerup", "pointercancel", "lostpointercapture"].forEach(type => button.addEventListener(type, releasePointer));
      button.addEventListener("keydown", event => {
        if (event.code !== "Space" && event.code !== "Enter") return;
        event.preventDefault();
        if (engine.state.status === "running") { heldButtons.add(action); syncInputs(); }
      });
      button.addEventListener("keyup", event => {
        if (event.code !== "Space" && event.code !== "Enter") return;
        event.preventDefault();
        heldButtons.delete(action);
        syncInputs();
      });
      button.addEventListener("blur", () => { heldButtons.delete(action); syncInputs(); });
    }
    document.addEventListener("pointerup", releasePointer);
    document.addEventListener("pointercancel", releasePointer);

    const formatTime = seconds => `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(Math.floor(seconds % 60)).padStart(2, "0")}`;
    const formatDistance = meters => meters >= 1000 ? { value: (meters / 1000).toFixed(2), unit: "KM" } : { value: String(Math.floor(meters)), unit: "M" };
    const tankPercent = () => (engine.communityWater / CHUG_RULES.tankCapacity * 100).toFixed(3);
    const tankAmount = () => `${engine.communityWater.toLocaleString("en-US")} / ${CHUG_RULES.tankCapacity.toLocaleString("en-US")}`;
    const setText = (id, text) => {
      const element = byId(id);
      const value = String(text);
      if (element.textContent !== value) element.textContent = value;
    };

    function showScreen(name) {
      currentScreen = name;
      Object.entries(screens).forEach(([key, screen]) => { screen.hidden = key !== name; });
      document.querySelectorAll("[data-step]").forEach(step => step.classList.toggle("current", step.dataset.step === name));
    }

    function resizeWorld() {
      if (currentScreen !== "game") return;
      const bounds = world.getBoundingClientRect();
      if (!bounds.width || !bounds.height) return;
      const scale = bounds.height / CHUG_RULES.worldHeight;
      engine.setViewport(bounds.width / scale);
      scene.style.width = `${engine.width}px`;
      scene.style.transform = `scale(${scale})`;
      render();
    }

    function stopLoop() {
      if (frameId !== null) cancelAnimationFrame(frameId);
      frameId = null;
      previousTime = null;
      accumulator = 0;
    }

    function beginLoop() {
      stopLoop();
      frameId = requestAnimationFrame(frame);
    }

    function startRun() {
      stopLoop();
      sound.stop();
      sound.unlock().then(syncSoundButton);
      scoreMilestones.reset();
      pendingScoreMilestones.length = 0;
      scoreMilestoneUntil = 0;
      scoreMilestone.hidden = true;
      scoreMilestone.textContent = "";
      levelAnnouncementUntil = 0;
      levelAnnouncement.hidden = true;
      levelAnnouncement.textContent = "";
      engine.start();
      boneSeed = (boneSeed + 0x9e3779b9) >>> 0;
      for (const layer of boneLayers) {
        layer.tiles.forEach(tile => tile.remove());
        layer.tiles.clear();
      }
      confetti.textContent = "";
      celebrationUntil = 0;
      clearControls();
      sprites.forEach(removeSprite);
      feedback.forEach(effect => effect.remove());
      sprites.clear();
      feedback.clear();
      showScreen("game");
      pauseOverlay.hidden = true;
      screens.game.classList.remove("is-paused");
      pauseButton.setAttribute("aria-label", "Pause game");
      pauseButton.innerHTML = "Ⅱ <span>PAUSE</span>";
      controlButtons.forEach(button => { button.disabled = false; });
      messageUntil = 3.6;
      messageKind = "";
      message.textContent = "COLLECT BLUE WATER. WATCH FOR POLLUTION!";
      announcer.textContent = "Run started. A/D or Left/Right to move. Space or Up to double jump. Hold S or Down to slide under cactus arms and barriers. Watch vent warnings; inactive vents are safe.";
      resizeWorld();
      world.focus({ preventScroll: true });
      beginLoop();
    }

    function pauseRun(away = false) {
      if (!engine.pause()) return;
      sound.stop();
      stopLoop();
      clearControls();
      pauseOverlay.hidden = false;
      screens.game.classList.add("is-paused");
      setText("pause-reason", away ? "Your run paused while you were away." : "Ready when you are.");
      pauseButton.setAttribute("aria-label", "Resume game");
      pauseButton.innerHTML = "▶ <span>RESUME</span>";
      controlButtons.forEach(button => { button.disabled = true; });
      announcer.textContent = "Run paused.";
      byId("resume-button").focus({ preventScroll: true });
    }

    function resumeRun() {
      if (!engine.resume()) return;
      sound.unlock().then(syncSoundButton);
      pauseOverlay.hidden = true;
      screens.game.classList.remove("is-paused");
      pauseButton.setAttribute("aria-label", "Pause game");
      pauseButton.innerHTML = "Ⅱ <span>PAUSE</span>";
      controlButtons.forEach(button => { button.disabled = false; });
      world.focus({ preventScroll: true });
      beginLoop();
    }

    function setMessage(text, kind, duration = 2) {
      message.textContent = text;
      messageKind = kind;
      messageUntil = engine.state.elapsed + duration;
    }

    function handleEvents() {
      for (const event of engine.drainEvents()) {
        if (event.type === "eagle-warning") {
          sound.play("screech");
          announcer.textContent = "Eagle diving! Slide or move away after it commits.";
        } else if (event.type === "behind") {
          announcer.textContent = "Keep up! Move right to recover within four seconds. Maximum off-screen allowance: one point five meters beyond the left edge.";
        } else if (event.type === "recovered") {
          announcer.textContent = "Caught up! Recovery timer cleared.";
        } else if (event.type === "level") {
          levelAnnouncementUntil = engine.state.elapsed + 2.6;
          levelAnnouncement.textContent = `LEVEL ${event.level}! ${event.speedIncreased ? "SPEED INCREASED!" : "KEEP RUNNING!"}`;
          announcer.textContent = `Level ${event.level}. ${event.speedIncreased ? "The world is gradually accelerating." : "Keep running for clean water."}`;
        } else if (event.type === "water") {
          sound.play("water");
          // Snapshot score preserves a crossing even if damage follows in this frame.
          pendingScoreMilestones.push(...scoreMilestones.check(event.score));
          announcer.textContent = `Water collected. Score ${engine.state.score}. ${engine.state.water} drops. Community tank ${tankAmount()} water units, ${tankPercent()} percent full.`;
        } else if (event.type === "damage") {
          sound.play("damage");
          const scoreLoss = event.penalty ? ` · −${event.penalty} SCORE` : "";
          const cause = event.kind === "boulder" ? "Boulder" : event.kind.startsWith("cactus") || event.kind === "prickly-pear" ? "Cactus" : "Pollution";
          setMessage(`${cause.toUpperCase()}! −1 HEART${scoreLoss}`, "damage");
          announcer.textContent = `${cause} hit. ${event.hearts} hearts left. Score ${engine.state.score}.`;
        } else if (event.type === "chug") {
          if (engine.state.elapsed >= celebrationUntil) setMessage(`CHUG! AUTOMATIC SIP · TANK ${tankPercent()}% FULL`, "chug", 1.7);
        } else if (event.type === "milestone" || event.type === "full") {
          const full = event.type === "full";
          const text = full ? "COMMUNITY TANK FULL! 20,000 UNITS! KEEP RUNNING!" : `COMMUNITY TANK ${event.percent}% FULL! EVERY DROP COUNTS!`;
          celebrationUntil = engine.state.elapsed + (full ? 4 : 1.8);
          setMessage(text, full ? "full" : "milestone", full ? 4 : 2.5);
          announcer.textContent = text;
          if (full) {
            sound.play("full");
            const colors = ["#469bd8", "#f3d443", "#49aa5f", "#ef8a3c", "#ffffff"];
            for (let index = 0; index < 48; index += 1) {
              const piece = document.createElement("i");
              piece.style.left = `${index / 48 * 100}%`;
              piece.style.backgroundColor = colors[index % colors.length];
              piece.style.animationDelay = `${index % 7 * 0.07}s`;
              piece.style.animationDuration = `${2.2 + index % 5 * 0.2}s`;
              piece.style.rotate = `${index * 47}deg`;
              piece.addEventListener("animationend", () => piece.remove());
              confetti.append(piece);
            }
          }
        }
      }
    }

    function removeSprite(sprite) {
      sprite.remove();
      sprite.frontLayer?.remove();
      sprite.groundShadow?.remove();
    }

    function makeSprite(object) {
      const sprite = document.createElement("div");
      sprite.dataset.objectId = String(object.id);
      sprite.dataset.kind = object.kind;
      sprite.style.width = `${object.width}px`;
      sprite.style.height = `${object.height}px`;
      if (object.kind === "water") {
        sprite.className = "game-object water-pickup";
        sprite.dataset.pickupBand = CHUG_RULES.groundY - object.y - object.height > 80 ? "air" : "low";
        sprite.innerHTML = '<svg viewBox="0 0 64 82"><use href="#water-drop"/></svg>';
      } else if (object.kind === "boulder" || object.kind === "prickly-pear") {
        sprite.className = `game-object hazard ${object.kind}-hazard`;
        sprite.dataset.variant = String(object.variant);
        sprite.innerHTML = naturalObstacleArt(object);
      } else if (engine.isOverhead(object)) {
        const layout = engine.overhangLayout(object);
        sprite.className = `game-object hazard overhead-hazard ${object.kind === "barrier" ? "barrier-hazard" : "cactus-hazard"}`;
        sprite.dataset.variant = String(object.variant);
        sprite.innerHTML = object.kind === "cactus-overhead" ? cactusObstacleArt(object, "rear")
          : `<svg class="obstacle-art obstacle-supports" viewBox="0 0 272 300"><use href="#${layout.supports}"/></svg>`;
        // A sibling at Z=6 lets the solid overhang occlude the runner (Z=5),
        // while the roadside trunk or track-mounted supports stay behind it.
        const front = document.createElement("div");
        front.className = `game-object hazard-front${object.kind === "cactus-overhead" ? " cactus-crossing" : ""}`;
        front.dataset.ownerId = String(object.id);
        front.style.width = `${object.width}px`;
        front.style.height = `${object.height}px`;
        front.innerHTML = object.kind === "cactus-overhead" ? cactusObstacleArt(object, "front")
          : `<svg class="obstacle-art obstacle-crossing" viewBox="0 0 272 300"><use href="#${layout.face}"/></svg>`;
        sprite.frontLayer = front;
        byId("objects").append(front);
      } else if (object.kind === "cactus") {
        sprite.className = "game-object hazard cactus-hazard";
        sprite.innerHTML = '<svg viewBox="0 0 110 125"><use href="#cactus-ground-art"/></svg>';
      } else if (object.kind === "vent") {
        sprite.className = "game-object hazard vent-hazard";
        // Shared soft fields stay over the existing hitboxes; only the wisps
        // and bubbles drift. Per-object IDs keep multiple vents independent.
        const gasId = `vent-gas-${object.id}`;
        sprite.innerHTML = `<svg class="obstacle-art" viewBox="0 0 112 164">
          <defs>
            <radialGradient id="${gasId}-haze">
              <stop stop-color="#b8cd69" stop-opacity=".43"/>
              <stop offset=".45" stop-color="#b8cd69" stop-opacity=".31"/>
              <stop offset=".76" stop-color="#a7be65" stop-opacity=".13"/>
              <stop offset="1" stop-color="#a7be65" stop-opacity="0"/>
            </radialGradient>
            <radialGradient id="${gasId}-mist">
              <stop stop-color="#e3e8a1" stop-opacity=".28"/>
              <stop offset=".5" stop-color="#d3df8a" stop-opacity=".17"/>
              <stop offset="1" stop-color="#c8d77f" stop-opacity="0"/>
            </radialGradient>
            <linearGradient id="${gasId}-curl" x1="0" y1="1" x2="1" y2="0">
              <stop stop-color="#8aa746" stop-opacity="0"/>
              <stop offset=".3" stop-color="#829d3f" stop-opacity=".38"/>
              <stop offset=".65" stop-color="#c6d77e" stop-opacity=".3"/>
              <stop offset="1" stop-color="#dfe6a1" stop-opacity="0"/>
            </linearGradient>
          </defs>
          <g class="vent-cloud">
            <g class="vent-haze">
              <ellipse cx="56" cy="124" rx="38" ry="37" fill="url(#${gasId}-haze)"/>
              <ellipse cx="61" cy="79" rx="31" ry="37" fill="url(#${gasId}-haze)"/>
              <ellipse cx="65" cy="36" rx="22" ry="28" fill="url(#${gasId}-haze)"/>
              <ellipse cx="47" cy="64" rx="22" ry="24" fill="url(#${gasId}-mist)"/>
              <ellipse cx="54" cy="149" rx="25" ry="14" fill="url(#${gasId}-mist)"/>
            </g>
            <g class="vent-drift">
              <ellipse cx="48" cy="119" rx="27" ry="28" fill="url(#${gasId}-mist)"/>
              <ellipse cx="72" cy="94" rx="24" ry="25" fill="url(#${gasId}-haze)"/>
              <path d="M42 155c-12-12-16-29-2-39 12-9 28-5 32-16" fill="none" stroke="url(#${gasId}-curl)" stroke-width="5" stroke-linecap="round"/>
            </g>
            <g class="vent-swirl" fill="none" stroke-linecap="round">
              <path d="M35 143c-12-14-3-29 14-28 22 1 33-11 25-24-6-10-22-12-28-3-5 8 3 16 12 11" stroke="url(#${gasId}-curl)" stroke-width="2.5"/>
              <path d="M53 104c-15-13-18-28-5-37 12-9 28-2 28 10 0 7-9 10-13 5" stroke="url(#${gasId}-curl)" stroke-width="1.8"/>
              <path d="M62 65c13-10 13-18 3-26-8-7-4-17 5-18" stroke="url(#${gasId}-curl)" stroke-width="1.6"/>
              <path d="M40 137c-5-11 0-19 12-21m8-50c13-6 15-17 6-23" stroke="#f0efbd" stroke-opacity=".25" stroke-width="1.4"/>
            </g>
            <g class="vent-bubbles" fill="#e2e9a4" fill-opacity=".12" stroke="#829b46" stroke-opacity=".6" stroke-width="1">
              <g class="vent-bubble-rise bubble-drift-one"><circle cx="44" cy="133" r="3.2"/><circle cx="77" cy="98" r="2.2"/></g>
              <g class="vent-bubble-rise bubble-drift-two"><circle cx="50" cy="86" r="2.6"/><circle cx="66" cy="37" r="1.8"/></g>
              <g class="vent-bubble-rise bubble-drift-three"><circle cx="68" cy="119" r="3.6"/><circle cx="62" cy="64" r="2.3"/></g>
            </g>
          </g>
          <g class="vent-warning-puff" fill="none" stroke="#b89947" stroke-opacity=".5" stroke-width="1.6" stroke-linecap="round">
            <path d="M43 151c-6-5-6-11 0-15 5-4 5-8 2-11m18 26c6-6 7-10 2-14-4-4-3-8 1-10"/>
          </g>
          <rect x="4" y="154" width="104" height="10" rx="4" fill="#535e62" stroke="#22292c" stroke-width="2"/>
          <path d="M20 156v6m14-6v6m14-6v6m14-6v6m14-6v6m14-6v6" stroke="#c4ccca" stroke-width="5"/>
          </svg><span class="vent-light"></span>`;
      } else {
        sprite.className = `game-object hazard${object.kind === "spill" ? " spill-only" : " barrel-hazard"}${object.wide ? " wide-spill" : ""}`;
        sprite.innerHTML = (object.kind === "barrel" ? '<svg class="barrel" viewBox="0 0 120 150"><use href="#toxic-barrel"/></svg>' : "")
          + `<svg class="spill-art" viewBox="0 0 ${object.width} 12">`
          + `<ellipse cx="${object.width / 2}" cy="6" rx="${(object.width - 8) / 2}" ry="6" fill="#718b23"/>`
          + `<ellipse cx="${object.width / 2}" cy="5.5" rx="${(object.width - 16) / 2}" ry="3.8" fill="#bbd532"/>`
          + `<ellipse cx="${object.width * 0.43}" cy="4" rx="${object.width * 0.23}" ry="1" fill="#e6f478"/>`
          + `<ellipse cx="${object.width * 0.74}" cy="7" rx="4" ry="1.8" fill="#e6f478"/>`
          + '<ellipse cx="26" cy="6" rx="3" ry="1.4" fill="#9aae27"/></svg>';
      }
      if (object.kind !== "water") {
        const cue = document.createElement("span");
        cue.className = `jump-cue${engine.isOverhead(object) ? " slide-cue" : ""}`;
        cue.textContent = object.wide ? "DOUBLE JUMP!" : CHUG_HAZARDS[object.kind].cue;
        if (!engine.isOverhead(object)) {
          const mounted = object.kind === "barrel" || object.kind === "cactus";
          const width = object.kind === "vent" ? 112 : object.wide ? 136 : mounted ? 78 : Math.max(84, cue.textContent.length * 7 + 18);
          const x = object.kind === "barrel" ? 27 : object.kind === "cactus" ? 16 : object.kind === "vent" ? 0 : 12;
          const y = object.kind === "barrel" ? 40 : object.kind === "cactus" ? 58 : object.height - 64;
          cue.classList.add("track-cue");
          cue.style.left = `${x}px`;
          cue.style.top = `${y}px`;
          cue.style.width = `${width}px`;
          if (!mounted) {
            const post = document.createElement("span");
            post.className = "warning-post";
            post.style.left = `${x + width / 2 - 2.5}px`;
            post.style.top = `${y + 26}px`;
            post.style.height = `${object.height - y - 26}px`;
            sprite.append(post);
            sprite.warningPost = post;
          }
        }
        (sprite.frontLayer || sprite).append(cue);
        sprite.hazardCue = cue;
      }
      if (!engine.isOverhead(object)) {
        const shadow = document.createElement("span");
        shadow.className = `ground-shadow${object.kind === "water" ? " pickup-shadow" : ""}`;
        shadow.dataset.ownerId = String(object.id);
        const air = sprite.dataset.pickupBand === "air";
        const width = object.kind === "water" ? air ? 16 : 28 : object.kind === "barrel" ? 92 : object.width - 8;
        shadow.style.width = `${width}px`;
        shadow.style.height = object.kind === "water" ? "5px" : "8px";
        shadow.style.opacity = object.kind === "water" ? air ? "0.08" : "0.16" : "0.18";
        shadow.offsetInObject = (object.width - width) / 2;
        sprite.groundShadow = shadow;
        byId("object-shadows").append(shadow);
      }
      byId("objects").append(sprite);
      sprites.set(object.id, sprite);
      return sprite;
    }

    function makeBoneTile(layer, index) {
      let seed = (boneSeed ^ Math.imul(index + 1, 0x9e3779b1) ^ layer.salt) >>> 0;
      const random = () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let bits = Math.imul(seed ^ seed >>> 15, seed | 1);
        bits ^= bits + Math.imul(bits ^ bits >>> 7, bits | 61);
        return ((bits ^ bits >>> 14) >>> 0) / 4294967296;
      };
      const tile = document.createElementNS(svgNS, "svg");
      tile.setAttribute("class", "bone-tile");
      tile.setAttribute("viewBox", `0 0 ${sceneryTileWidth} ${layer.height}`);
      // Three widely separated discoveries per tile. Fresh tiles vary on every
      // run instead of repeating a fixed bone pattern with the plant strip.
      const skullSlot = Math.floor(random() * (index === 0 ? 2 : 3));
      for (let slot = 0; slot < 3; slot += 1) {
        const type = slot === skullSlot ? "cattle-skull" : boneTypes[1 + Math.floor(random() * (boneTypes.length - 1))];
        const width = (68 + random() * 18) * layer.scale;
        const height = width * 68 / 112;
        const x = 120 + slot * 520 + random() * 270;
        const y = (layer.height - height) / 2 + (random() - 0.5) * 3;
        const angle = (random() - 0.5) * 18;
        const prop = document.createElementNS(svgNS, "g");
        prop.setAttribute("transform", `translate(${x} ${y}) rotate(${angle} ${width / 2} ${height / 2})`);
        const art = document.createElementNS(svgNS, "use");
        art.setAttribute("href", `#env-${type}`);
        art.setAttribute("width", width);
        art.setAttribute("height", height);
        prop.append(art);
        // Small sand lips, pebbles and occasional rocks ground each prop.
        const sand = document.createElementNS(svgNS, "path");
        sand.setAttribute("d", `M${width * 0.2} ${height * 0.88}q${width * 0.15} -2 ${width * 0.3} 0t${width * 0.25} 0`);
        sand.setAttribute("fill", "none");
        sand.setAttribute("stroke", "#e8c18b");
        sand.setAttribute("stroke-width", "2");
        sand.setAttribute("stroke-linecap", "round");
        prop.append(sand);
        if (random() < 0.55) {
          const rocks = document.createElementNS(svgNS, "use");
          rocks.setAttribute("href", "#env-rocks");
          rocks.setAttribute("x", width - 4);
          rocks.setAttribute("y", height * 0.68);
          rocks.setAttribute("width", 19 * layer.scale);
          rocks.setAttribute("height", 9 * layer.scale);
          prop.append(rocks);
        }
        tile.append(prop);
      }
      layer.element.append(tile);
      layer.tiles.set(index, tile);
      return tile;
    }

    function renderBones(traveled) {
      for (const layer of boneLayers) {
        const offset = traveled * layer.speed;
        const first = Math.floor(offset / sceneryTileWidth);
        const last = Math.floor((offset + engine.width) / sceneryTileWidth);
        for (const [index, tile] of layer.tiles) {
          if (index < first || index > last) {
            tile.remove();
            layer.tiles.delete(index);
          }
        }
        for (let index = first; index <= last; index += 1) {
          const tile = layer.tiles.get(index) || makeBoneTile(layer, index);
          tile.style.transform = `translate3d(${index * sceneryTileWidth - offset}px, 0, 0)`;
        }
      }
    }

    function render() {
      const state = engine.state;
      const allowance = Math.max(0, CHUG_RULES.maxBehindMeters - state.behindDistance);
      const warning = byId("behind-warning");
      warning.hidden = state.behindDistance === 0;
      warning.dataset.urgency = state.recoveryRemaining <= 1.5 || allowance <= 0.4 ? "danger" : "warning";
      setText("behind-countdown", `${state.recoveryRemaining.toFixed(1)}s`);
      setText("behind-allowance", allowance.toFixed(2));
      byId("behind-fill").style.width = `${allowance / CHUG_RULES.maxBehindMeters * 100}%`;
      byId("behind-meter").setAttribute("aria-valuenow", allowance.toFixed(2));
      setText("level-number", state.level);
      setText("run-difficulty", CHUG_DIFFICULTIES[engine.difficulty].label.toUpperCase());
      levelAnnouncement.hidden = state.elapsed >= levelAnnouncementUntil;
      byId("level-indicator").classList.toggle("just-advanced", state.elapsed < levelAnnouncementUntil);
      if (state.elapsed >= scoreMilestoneUntil) {
        const milestone = pendingScoreMilestones.shift();
        scoreMilestone.hidden = !milestone;
        if (milestone) {
          scoreMilestone.textContent = milestone.message;
          scoreMilestoneUntil = state.elapsed + 3.2;
        }
      }
      const distance = formatDistance(state.distance);
      setText("score", state.score);
      setText("distance", distance.value);
      setText("distance-unit", distance.unit);
      setText("timer", formatTime(state.elapsed));
      setText("water-count", state.water);
      setText("sip-count", state.sips);
      setText("tank-percent", `${tankPercent()}%`);
      setText("tank-amount", tankAmount());
      byId("hud-tank-fill").style.height = `${tankPercent()}%`;
      byId("hud-tank").setAttribute("aria-label", `Community tank ${tankAmount()} water units, ${tankPercent()} percent full`);
      byId("hud-tank").classList.toggle("is-celebrating", state.elapsed < celebrationUntil);
      const hearts = byId("hearts");
      hearts.setAttribute("aria-label", `${state.hearts} of 3 hearts remaining`);
      Array.from(hearts.children).forEach((heart, index) => heart.classList.toggle("lost", index >= state.hearts));

      runner.style.transform = `translate(${engine.playerX}px, ${CHUG_RULES.groundY - CHUG_RULES.runnerFeet - state.jumpY}px)`;
      runner.classList.toggle("is-airborne", !engine.isGrounded());
      runner.classList.toggle("is-sliding", state.sliding);
      runner.classList.toggle("is-crouching", state.slideProgress > 0);
      setRunnerPose(state.slideProgress);
      // Read the next surface for touchdown preparation without changing physics.
      const feet = CHUG_RULES.groundY - state.jumpY;
      let clearance = state.jumpY;
      if (!engine.isGrounded()) {
        for (const object of engine.objects) {
          if (object.kind !== "boulder") continue;
          const surface = engine.boulderSurface(object);
          if (surface !== null && surface >= feet) clearance = Math.min(clearance, surface - feet);
        }
      }
      runnerAnimation.update({ elapsed: state.elapsed, distance: engine.playerWorldX,
        grounded: engine.isGrounded(), slideProgress: state.slideProgress,
        clearance, velocity: state.velocity, gravity: engine.verticalGravity() });
      for (const [action, button] of Object.entries(holdButtons)) {
        button.setAttribute("aria-pressed", String(action === "slide" ? state.sliding : engine.input[action]));
      }
      const recovering = (state.status === "running" || state.status === "paused") && state.invulnerable > 0;
      const flashing = recovering && state.damageFlash > 0;
      runner.classList.toggle("is-invulnerable", recovering);
      runner.classList.toggle("is-damage-flash", flashing);
      // The same active-play clock drives immunity and fading, so pause/replay
      // cannot leave an independent CSS animation or timer running.
      const fadeTime = Math.max(0, CHUG_RULES.invulnerability - state.invulnerable - CHUG_RULES.damageFlashDuration);
      runner.style.opacity = recovering && !flashing && !motionPreference?.matches
        ? String(0.7 + 0.3 * Math.cos(2 * Math.PI * fadeTime / CHUG_RULES.damageFadePeriod)) : "1";
      runner.classList.toggle("is-sipping", state.sipGlow > 0);
      const shadowScale = state.platformId !== null ? 1 : Math.max(0.35, 1 - state.jumpY / 330);
      byId("runner-shadow").style.top = `${CHUG_RULES.groundY - (state.platformId !== null ? state.jumpY : 0)}px`;
      byId("runner-shadow").style.transform = `translateX(${engine.playerX + 33}px) scale(${shadowScale})`;
      byId("speed-lines").style.transform = `translate(${engine.playerX - 20}px, 252px)`;
      for (const { element, speed } of sceneryLayers) {
        element.style.transform = `translate3d(${-(engine.cameraX * speed) % sceneryTileWidth}px, 0, 0)`;
      }
      renderBones(engine.cameraX);
      trackPebbles.style.transform = `translate3d(${-engine.cameraX % 160}px, 0, 0)`;
      world.classList.toggle("damage-flash", flashing);
      message.hidden = state.elapsed > messageUntil;
      message.className = `run-message ${messageKind}`;

      if (engine.eagle) {
        const bird = engine.eagle;
        if (!eagleSprite) {
          const element = document.createElement("div");
          element.className = "game-object eagle-enemy";
          const art = createEagleArt(document); element.append(art.svg);
          byId("objects").append(element); eagleSprite = { element, art };
        }
        eagleSprite.element.dataset.phase = bird.phase;
        eagleSprite.element.style.transform = `translate(${bird.worldX - engine.cameraX}px, ${bird.y}px)`;
        eagleSprite.art.update(bird, motionPreference?.matches || false);
      } else if (eagleSprite) { eagleSprite.element.remove(); eagleSprite = null; }
      const activeObjects = new Set();
      for (const object of engine.objects) {
        // Keep distant future objects out of the DOM until they approach the viewport.
        if (object.x > engine.width + 160) continue;
        activeObjects.add(object.id);
        const sprite = sprites.get(object.id) || makeSprite(object);
        sprite.style.transform = `translate(${object.x}px, ${object.y}px)`;
        sprite.classList.toggle("was-hit", object.hit);
        if (sprite.groundShadow) {
          sprite.groundShadow.style.transform = `translate(${object.x + sprite.groundShadow.offsetInObject}px, ${CHUG_RULES.groundY}px)`;
        }
        if (sprite.frontLayer) {
          sprite.frontLayer.style.transform = sprite.style.transform;
          sprite.frontLayer.classList.toggle("was-hit", object.hit);
        }
        if (object.kind === "vent") {
          const phase = engine.ventState(object);
          sprite.dataset.ventState = phase;
          sprite.hazardCue.textContent = phase === "active" ? "TOXIC! JUMP" : phase === "warning" ? "WARNING!" : "VENT OFF";
        }
      }
      for (const [id, sprite] of sprites) {
        if (!activeObjects.has(id)) { removeSprite(sprite); sprites.delete(id); }
      }

      const activeEffects = new Set();
      for (const effect of engine.effects) {
        activeEffects.add(effect.id);
        let element = feedback.get(effect.id);
        if (!element) {
          element = document.createElement("span");
          element.className = `floating-feedback ${effect.kind}`;
          element.textContent = effect.text;
          byId("effects").append(element);
          feedback.set(effect.id, element);
        }
        element.style.transform = `translate(${effect.x}px, ${effect.y}px)`;
        element.style.opacity = String(Math.min(1, effect.life * 2));
      }
      for (const [id, element] of feedback) {
        if (!activeEffects.has(id)) { element.remove(); feedback.delete(id); }
      }
    }

    function finishRun() {
      stopLoop();
      clearControls();
      controlButtons.forEach(button => { button.disabled = true; });
      const state = engine.state;
      if (state.endReason === "fell-behind") sound.stop();
      setText("run-outcome", state.endReason === "fell-behind" ? "YOU FELL BEHIND!" : "RUN COMPLETE");
      byId("run-outcome").dataset.reason = state.endReason;
      const distance = formatDistance(state.distance);
      setText("final-level", state.level);
      setText("final-difficulty", CHUG_DIFFICULTIES[engine.difficulty].label.toUpperCase());
      setText("final-score", state.score);
      setText("final-water", state.water);
      setText("final-distance", `${distance.value} ${distance.unit.toLowerCase()}`);
      setText("final-time", formatTime(state.elapsed));
      setText("final-tank", `+${state.deposited.toLocaleString("en-US")}`);
      setText("results-tank-label", `${tankPercent()}%`);
      setText("results-tank-amount", `${tankAmount()} WATER UNITS`);
      byId("results-tank-label").setAttribute("fill", engine.communityWater / CHUG_RULES.tankCapacity >= 0.35 ? "#ffffff" : "#216d9f");
      byId("results-tank").setAttribute("aria-label", `Community water tank ${tankAmount()} water units, ${tankPercent()} percent full`);
      const fraction = engine.communityWater / CHUG_RULES.tankCapacity;
      // Keep the decorative wave from exaggerating nearly empty or nearly full tanks.
      const waveHeight = Math.min(8, 124 * fraction, 124 * (1 - fraction));
      const wave = `M42 53q22 ${-waveHeight} 44 0t44 0 44 0 44 0`;
      byId("results-tank-water").setAttribute("d", `${wave}v190H42Z`);
      byId("results-tank-wave").setAttribute("d", wave);
      byId("results-tank-water").style.opacity = engine.communityWater === 0 ? "0" : "1";
      byId("results-tank-wave").style.opacity = engine.communityWater === 0 ? "0" : "1";
      setText("results-message", state.deposited ? `You deposited ${state.deposited.toLocaleString("en-US")} water ${state.deposited === 1 ? "unit" : "units"}. Your community tank progress is saved!` : engine.communityWater === CHUG_RULES.tankCapacity ? "The community tank is full! Keep running and collecting water for points." : "Every drop counts. Your community tank progress is saved. Try again!");
      showScreen("results");
      byId("results-tank").getBoundingClientRect(); // Establish the visible waterline before its transition.
      byId("results-tank-level").style.transform = `translateY(${124 * (1 - fraction)}px)`;
      byId("results-title").focus({ preventScroll: true });
      announcer.textContent = `${state.endReason === "fell-behind" ? "YOU FELL BEHIND!" : "Run complete."} ${CHUG_DIFFICULTIES[engine.difficulty].label} difficulty, level ${state.level}. Final score ${state.score}. ${state.water} water drops, ${state.sips} consumed and ${state.deposited} deposited. ${Math.floor(state.distance)} meters. Time ${formatTime(state.elapsed)}. Community tank ${tankAmount()} water units, ${tankPercent()} percent full.`;
    }

    function frame(now) {
      frameId = null;
      if (engine.state.status !== "running") return;
      if (previousTime !== null) accumulator += Math.min(0.1, Math.max(0, (now - previousTime) / 1000));
      previousTime = now;
      const step = 1 / 120;
      while (accumulator >= step && engine.state.status === "running") {
        engine.update(step);
        accumulator -= step;
      }
      handleEvents();
      render();
      if (engine.state.status === "ended") finishRun();
      else frameId = requestAnimationFrame(frame);
    }

    function syncSoundButton() {
      soundButton.disabled = !sound.supported;
      soundButton.textContent = sound.supported ? `SOUND ${sound.enabled ? "ON" : "OFF"}` : "SOUND UNAVAILABLE";
      soundButton.setAttribute("aria-pressed", String(sound.enabled));
      soundButton.setAttribute("aria-label", sound.supported ? `Sound ${sound.enabled ? "on. Turn sound off" : "off. Turn sound on"}` : "Sound is unavailable in this browser");
    }
    syncSoundButton();
    for (const [mode, button] of Object.entries(difficultyButtons)) {
      button.addEventListener("click", () => {
        if (currentScreen !== "start" || !engine.setDifficulty(mode)) return;
        for (const [choice, option] of Object.entries(difficultyButtons)) {
          option.setAttribute("aria-pressed", String(choice === engine.difficulty));
        }
      });
    }
    soundButton.addEventListener("click", () => {
      sound.setEnabled(!sound.enabled);
      syncSoundButton();
      if (sound.enabled) sound.unlock().then(syncSoundButton);
    });
    byId("play-button").addEventListener("click", startRun);
    byId("again-button").addEventListener("click", startRun);
    byId("reset-button").addEventListener("click", startRun);
    byId("resume-button").addEventListener("click", resumeRun);
    pauseButton.addEventListener("click", () => engine.state.status === "paused" ? resumeRun() : pauseRun());
    byId("title-button").addEventListener("click", () => {
      stopLoop();
      sound.stop();
      clearControls();
      engine.reset();
      showScreen("start");
      byId("play-button").focus({ preventScroll: true });
    });
    jumpButton.addEventListener("pointerdown", event => {
      if (event.pointerType === "mouse" && event.button !== 0) return;
      event.preventDefault();
      engine.jump();
    });
    // Keyboard and assistive activation produces a click without pointerdown.
    jumpButton.addEventListener("click", event => { if (event.detail === 0) engine.jump(); });
    document.addEventListener("keydown", event => {
      if (currentScreen !== "game" || event.ctrlKey || event.altKey || event.metaKey) return;
      if (keyActions[event.code]) {
        event.preventDefault();
        if (engine.state.status === "running") { heldKeys.add(event.code); syncInputs(); }
        return;
      }
      const onButton = event.target instanceof Element && event.target.closest("button");
      if (event.code === "Space" || event.code === "ArrowUp") {
        if (event.code === "Space" && onButton && onButton !== jumpButton) return;
        event.preventDefault();
        if (!event.repeat) engine.jump();
      } else if ((event.code === "KeyP" || event.code === "Escape") && !event.repeat) {
        event.preventDefault();
        if (engine.state.status === "paused") resumeRun();
        else pauseRun();
      }
    });
    document.addEventListener("keyup", event => {
      if (!keyActions[event.code]) return;
      if (currentScreen === "game") event.preventDefault();
      heldKeys.delete(event.code);
      syncInputs();
    });
    document.addEventListener("visibilitychange", () => { if (document.hidden) pauseRun(true); });
    window.addEventListener("blur", () => pauseRun(true));
    window.addEventListener("resize", resizeWorld);
    if (typeof ResizeObserver !== "undefined") new ResizeObserver(resizeWorld).observe(world);
  })();
}
