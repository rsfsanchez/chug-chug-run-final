/* Presentation-only runner rig. No physics, inputs, or collision state is changed. */
(function (root) {
  "use strict";
  const TAU = Math.PI * 2;
  const DEG = 180 / Math.PI;
  const RIG = Object.freeze({ hipX: 94, hipY: 132, thigh: 28, shin: 27, upperArm: 31, forearm: 28,
    floor: 177, stride: 136, artScale: .8, stance: .4 });
  const FOOT = "M-5-5Q0-8 7-5L18-4Q22-3 22 1L20 6H-5Q-8 4-7 0Z";
  const clamp = value => Math.max(0, Math.min(1, value));
  const smooth = value => { const t = clamp(value); return t * t * (3 - 2 * t); };
  const mix = (a, b, t) => a + (b - a) * t;
  const wrap = value => (value % 1 + 1) % 1;
  const angleMix = (a, b, t) => a + Math.atan2(Math.sin(b - a), Math.cos(b - a)) * t;

  function solveLeg(hip, target, footAngle) {
    const dx = target.x - hip.x, dy = target.y - hip.y;
    const reach = Math.hypot(dx, dy);
    const distance = Math.max(Math.abs(RIG.thigh - RIG.shin) + .001, Math.min(RIG.thigh + RIG.shin - .001, reach));
    const ux = dx / (reach || 1), uy = dy / (reach || 1);
    const along = (RIG.thigh ** 2 - RIG.shin ** 2 + distance ** 2) / (2 * distance);
    const bend = Math.sqrt(Math.max(0, RIG.thigh ** 2 - along ** 2));
    // Always choose the forward-facing knee solution. The knee cannot flip to
    // the other IK branch while the heel passes under the hip during recovery.
    const knee = { x: hip.x + ux * along + uy * bend, y: hip.y + uy * along - ux * bend };
    const ankle = { x: hip.x + ux * distance, y: hip.y + uy * distance };
    const thigh = Math.atan2(knee.y - hip.y, knee.x - hip.x);
    const shin = Math.atan2(ankle.y - knee.y, ankle.x - knee.x);
    return { hip, knee, ankle, thigh, flex: wrap((shin - thigh) / TAU) * TAU, footAngle,
      clamped: Math.abs(reach - distance) > 1e-7 };
  }

  function forwardLeg(hip, thigh, flex, footAngle) {
    const knee = { x: hip.x + Math.cos(thigh) * RIG.thigh, y: hip.y + Math.sin(thigh) * RIG.thigh };
    const ankle = { x: knee.x + Math.cos(thigh + flex) * RIG.shin, y: knee.y + Math.sin(thigh + flex) * RIG.shin };
    return { hip, knee, ankle, thigh, flex, footAngle, clamped: false };
  }

  function stanceFoot(phase) {
    const angle = phase < .07 ? -6 * (1 - smooth(phase / .07))
      : phase > .23 ? 25 * smooth((phase - .23) / (RIG.stance - .23)) : 0;
    const footAngle = angle / DEG;
    const x = 124 - RIG.stride / RIG.artScale * phase;
    // Heel strike, flat support, then toe roll. The active pivot follows the
    // scrolling terrain exactly, even while the player moves horizontally.
    const pivotX = angle < 0 ? -5 : 20;
    return { x: x + pivotX - (pivotX * Math.cos(footAngle) - 6 * Math.sin(footAngle)),
      y: RIG.floor - (pivotX * Math.sin(footAngle) + 6 * Math.cos(footAngle)), footAngle };
  }

  const toeOff = stanceFoot(RIG.stance), contact = stanceFoot(0);
  const recovery = [
    [.4, toeOff.x, toeOff.y, 25], [.52, 58, 139, 50], [.64, 82, 145, 12],
    [.76, 112, 143, -13], [.86, 130, 148, -15], [.94, 132, 163, -10], [1, contact.x, contact.y, -6]
  ];
  function spline(phase, component) {
    let index = 0;
    while (index < recovery.length - 2 && phase > recovery[index + 1][0]) index += 1;
    const a = recovery[index], b = recovery[index + 1], length = b[0] - a[0];
    const t = (phase - a[0]) / length;
    const tangent = i => i === 0 || i === recovery.length - 1 ? component === 1 ? -RIG.stride / RIG.artScale : 0
      : (recovery[i + 1][component] - recovery[i - 1][component]) / (recovery[i + 1][0] - recovery[i - 1][0]);
    return (2*t*t*t - 3*t*t + 1)*a[component] + (t*t*t - 2*t*t + t)*length*tangent(index)
      + (-2*t*t*t + 3*t*t)*b[component] + (t*t*t - t*t)*length*tangent(index + 1);
  }

  function arm(phase, shoulder) {
    const upper = (92 + 55 * Math.cos(TAU * phase)) / DEG;
    const flex = (88 + 8 * Math.sin(TAU * phase)) / DEG;
    return { shoulder, upper, flex };
  }
  function sampleCycle(phase) {
    phase = wrap(phase);
    const bodyY = -4 + 2.2 * Math.cos(TAU * 2 * (phase - .12));
    const hip = { x: RIG.hipX, y: RIG.hipY + bodyY };
    const legs = [wrap(phase + .5), phase].map(p => {
      const foot = p <= RIG.stance ? stanceFoot(p) : { x: spline(p, 1), y: spline(p, 2), footAngle: spline(p, 3) / DEG };
      return { ...solveLeg(hip, foot, foot.footAngle), contact: p <= RIG.stance, phase: p };
    });
    return { bodyY, legs, arms: [arm(wrap(phase + .5), { x: 101, y: 87 }), arm(phase, { x: 116, y: 87 })], phase };
  }
  function blendPose(a, b, amount, lockContact = false) {
    const bodyY = mix(a.bodyY, b.bodyY, amount);
    const hip = { x: RIG.hipX, y: RIG.hipY + bodyY };
    return { ...b, bodyY,
      legs: b.legs.map((leg, index) => ({ ...leg, ...(lockContact && leg.contact ? solveLeg(hip, leg.ankle, leg.footAngle)
        : forwardLeg(hip, angleMix(a.legs[index].thigh, leg.thigh, amount), mix(a.legs[index].flex, leg.flex, amount), angleMix(a.legs[index].footAngle, leg.footAngle, amount))) })),
      arms: b.arms.map((value, index) => ({ ...value, upper: angleMix(a.arms[index].upper, value.upper, amount), flex: mix(a.arms[index].flex, value.flex, amount) })) };
  }
  function airbornePose(clearance, velocity, gravity, phase) {
    const hip = { x: RIG.hipX, y: RIG.hipY };
    const tuck = { bodyY: 0, legs: [forwardLeg(hip, -30 / DEG, 148 / DEG, 5 / DEG), forwardLeg(hip, -60 / DEG, 150 / DEG, -8 / DEG)],
      arms: [{ shoulder: { x: 101, y: 87 }, upper: 125 / DEG, flex: 80 / DEG }, { shoulder: { x: 116, y: 87 }, upper: 45 / DEG, flex: 100 / DEG }] };
    // Unfold into contact before touchdown, including elevated rock surfaces.
    const time = velocity < 0 ? (velocity + Math.sqrt(velocity ** 2 + 2 * gravity * Math.max(0, clearance))) / gravity : Infinity;
    return blendPose(tuck, sampleCycle(phase), smooth(1 - time / .18));
  }

  function create(options) {
    const { document, svg, upperBody, rearLeg, frontLeg, originalParts, reducedMotion = () => false } = options;
    const ns = "http://www.w3.org/2000/svg";
    const make = (tag, attributes) => { const node = document.createElementNS(ns, tag); for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value); return node; };
    const group = make("g", { class: "articulated-runner", "aria-hidden": "true" });
    const bones = [0, 1].map(index => {
      const thigh = make("g", { class: `run-thigh ${index ? "front" : "rear"}` });
      const shin = make("g", { class: "run-shin" }), foot = make("g", { class: "run-foot" });
      const style = { fill: "none", stroke: "#17191a", "stroke-linecap": "round" };
      thigh.append(make("path", { ...style, d: `M0 0H${RIG.thigh}`, "stroke-width": index ? 20 : 18 }));
      shin.append(make("path", { ...style, d: `M0 0H${RIG.shin}`, "stroke-width": index ? 15 : 14 }));
      foot.append(make("path", { d: FOOT, fill: "#17191a" }));
      shin.append(foot); thigh.append(shin); group.append(thigh);
      return { thigh, shin, foot };
    });
    svg.append(group);
    const armPaths = [upperBody.children[5], upperBody.children[6]];
    let phase = 0, previousElapsed = null, previousDistance = null, wasGrounded = true;
    let pose = sampleCycle(0), entry = pose, entryTime = .14, active = null;
    const n = value => Number(value.toFixed(5));
    const setActive = value => {
      if (active === value) return;
      active = value;
      group.setAttribute("display", value ? "inline" : "none");
      rearLeg.setAttribute("display", value ? "none" : "inline");
      frontLeg.setAttribute("display", value ? "none" : "inline");
    };
    function paint(value) {
      upperBody.setAttribute("transform", `translate(0 ${n(value.bodyY)})`);
      value.legs.forEach((leg, index) => {
        const nodes = bones[index];
        nodes.thigh.setAttribute("transform", `translate(${n(leg.hip.x)} ${n(leg.hip.y)}) rotate(${n(leg.thigh * DEG)})`);
        nodes.shin.setAttribute("transform", `translate(${RIG.thigh} 0) rotate(${n(leg.flex * DEG)})`);
        nodes.foot.setAttribute("transform", `translate(${RIG.shin} 0) rotate(${n((leg.footAngle - leg.thigh - leg.flex) * DEG)})`);
      });
      value.arms.forEach((value, index) => {
        const { shoulder: s, upper, flex } = value;
        const e = { x: s.x + Math.cos(upper) * RIG.upperArm, y: s.y + Math.sin(upper) * RIG.upperArm };
        const h = { x: e.x + Math.cos(upper - flex) * RIG.forearm, y: e.y + Math.sin(upper - flex) * RIG.forearm };
        armPaths[index].setAttribute("d", `M${s.x} ${s.y} ${n(e.x)} ${n(e.y)} ${n(h.x)} ${n(h.y)}`);
      });
    }
    return { group, bones, update(state) {
      let dt = previousElapsed === null ? 0 : Math.max(0, Math.min(.1, state.elapsed - previousElapsed));
      if (previousElapsed === null || state.elapsed < previousElapsed) {
        phase = 0; pose = sampleCycle(0); entryTime = .14; dt = 0; wasGrounded = state.grounded;
      }
      const distanceDelta = previousDistance === null || dt === 0 ? 0 : state.distance - previousDistance;
      previousElapsed = state.elapsed; previousDistance = state.distance;
      if (state.slideProgress > 0) {
        setActive(false);
        armPaths.forEach((path, index) => path.setAttribute("d", originalParts[index + 10].getAttribute("d")));
        wasGrounded = state.grounded;
        return;
      }
      setActive(true);
      if (state.grounded) {
        if (!wasGrounded) { phase = phase < .5 ? 0 : .5; entry = pose; entryTime = 0; }
        else phase = wrap(phase + distanceDelta / RIG.stride);
        entryTime += dt;
        const target = sampleCycle(reducedMotion() ? .12 : phase);
        pose = entryTime < .14 ? blendPose(entry, target, smooth(entryTime / .14), true) : target;
      } else {
        const target = airbornePose(state.clearance, state.velocity, state.gravity, phase < .5 ? 0 : .5);
        pose = reducedMotion() ? target : blendPose(pose, target, 1 - Math.exp(-dt / .035));
      }
      wasGrounded = state.grounded;
      paint(pose);
      return pose;
    } };
  }
  const api = { RIG, FOOT, sampleCycle, solveLeg, forwardLeg, airbornePose, create };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.ChugRunnerAnimation = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
