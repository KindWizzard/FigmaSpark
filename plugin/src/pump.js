import spriteUrl from '../../assets/mascot/pixel-spark-sprites-v1.png';

export function animatePump(canvas) {
  const ctx = canvas.getContext('2d');
  const atlas = new Image();
  atlas.src = spriteUrl;
  ctx.imageSmoothingEnabled = false;
  const motion = matchMedia('(prefers-reduced-motion: reduce)');
  const balls = [];
  const W = 120, H = 80, START = 70, END = 115;
  let state = 'offline', load = 0, pending = 0, errorUntil = 0, lastFrame = 0;
  let pose = 'offline', poseStarted = 0, copyUntil = 0;

  function rect(x, y, w, h, color) {
    ctx.fillStyle = color;
    ctx.fillRect(Math.round(x), Math.round(y), w, h);
  }

  function drawPipe(error, connected, now) {
    // The gap and jam remain readable without text or color perception.
    const leftEnd = connected ? 81 : 76;
    rect(64, 62, leftEnd - 64, 7, '#233e37');
    rect(65, 63, leftEnd - 64, 5, '#70acc0');
    rect(66, 64, leftEnd - 65, 1, '#b9e5e4');
    rect(leftEnd - 2, 61, 3, 9, '#60835b');
    rect(leftEnd - 1, 62, 1, 6, '#b3cf96');
    rect(82, 61, 3, 9, connected ? '#60835b' : '#45534b');
    rect(83, 62, 1, 6, connected ? '#b3cf96' : '#7e8e82');

    if (error) {
      rect(85, 62, 12, 7, '#233e37'); rect(85, 63, 12, 5, '#70acc0');
      rect(97, 57, 7, 7, '#233e37'); rect(98, 58, 5, 5, '#70acc0');
      rect(104, 61, 6, 7, '#233e37'); rect(105, 62, 4, 5, '#70acc0');
      rect(110, 62, 7, 7, '#233e37'); rect(110, 63, 7, 5, '#70acc0');
      rect(99, 59, 4, 4, '#f9ad59'); rect(100, 59, 1, 1, '#ffe6a1');
      if (motion.matches || Math.floor(now / 400) % 2 === 0) {
        rect(99, 52, 1, 3, '#ffc58e'); rect(106, 54, 2, 1, '#ffc58e');
      }
    } else {
      rect(85, 62, 32, 7, '#233e37'); rect(85, 63, 32, 5, '#70acc0');
      rect(87, 64, 27, 1, '#b9e5e4');
    }
    rect(116, 61, 3, 9, connected ? '#60835b' : '#45534b');
    rect(117, 62, 1, 6, connected ? '#b3cf96' : '#7e8e82');
  }

  function draw(now) {
    requestAnimationFrame(draw);
    if (document.hidden || now - lastFrame < (motion.matches ? 250 : 50)) return;
    const dt = Math.min((now - lastFrame) / 1000, .1);
    lastFrame = now;
    const connected = state === 'connected';
    const error = now < errorUntil || state === 'error';
    for (let i = balls.length - 1; i >= 0; i--) {
      const ball = balls[i];
      if (!connected || now - ball.born > 4000) { balls.splice(i, 1); continue; }
      if (now < ball.born) continue;
      if (!motion.matches && !error) ball.x += ball.direction * (35 + Math.min(50, Math.log2(load + 1) * 2)) * dt;
      if (ball.x > END + 2 || ball.x < START - 2) balls.splice(i, 1);
    }
    const nextPose = error ? 'error' : !connected ? 'offline' : balls.length || pending ? 'pumping' : 'idle';
    if (nextPose !== pose) { pose = nextPose; poseStarted = now; }
    const row = { offline: 0, idle: 1, pumping: 2, error: 3 }[pose];
    const elapsed = now - poseStarted;
    let frame = 0;
    if (!motion.matches) {
      if (pose === 'pumping') frame = Math.floor(elapsed / (170 - Math.min(70, Math.log2(load + 1) * 4))) % 4;
      else if (pose === 'offline') frame = Math.floor(elapsed / 650) % 4;
      else if (pose === 'error') frame = Math.floor(elapsed / 450) % 4;
      else {
        // A brief blink/wave every few seconds keeps idle calm.
        const cycle = elapsed % 7000;
        frame = cycle < 600 ? Math.min(3, Math.floor(cycle / 150)) : 0;
      }
    }
    ctx.clearRect(0, 0, W, H);
    drawPipe(error, connected, now);
    if (connected && !error) {
      for (const ball of balls) {
        if (now < ball.born) continue;
        rect(ball.x - 2, 64, 5, 3, ball.direction > 0 ? '#b9f0bb' : '#9ad5ff');
        rect(ball.x - 1, 63, 3, 5, ball.direction > 0 ? '#b9f0bb' : '#9ad5ff');
        rect(ball.x - 1, 64, 2, 1, '#f0fff5');
      }
    }
    if (atlas.complete && atlas.naturalWidth) {
      const cellWidth = atlas.naturalWidth / 4, cellHeight = atlas.naturalHeight / 4;
      ctx.drawImage(atlas, (now < copyUntil ? 2 : frame) * cellWidth, (now < copyUntil ? 1 : row) * cellHeight, cellWidth, cellHeight, -3, 0, 80, 80);
    }
  }

  requestAnimationFrame(draw);
  return {
    setState(value) { state = value; errorUntil = 0; if (value !== 'connected') balls.length = 0; },
    setLoad(bytesPerSecond, queue) { load = Math.max(0, bytesPerSecond); pending = Math.max(0, queue); },
    packet(bytes, direction) {
      if (state !== 'connected' || bytes <= 0) return;
      const count = Math.max(1, Math.min(10, Math.ceil(bytes / 8192)));
      const now = performance.now();
      for (let i = 0; i < count; i++) {
        if (balls.length >= 40) balls.shift();
        const outward = direction === 'out';
        balls.push({
          x: motion.matches ? 85 + i * 3 : outward ? START : END,
          direction: outward ? 1 : -1,
          born: now + (motion.matches ? 0 : i * 100)
        });
      }
    },
    error() { errorUntil = performance.now() + 6000; },
    copied() { copyUntil = performance.now() + 1000; }
  };
}
