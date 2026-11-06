(() => {
  const container = document.getElementById('particles');
  const count = 70;

  function place(particle) {
    particle.style.left = `${Math.random() * 100}%`;
    particle.style.top = `${Math.random() * 100}%`;
    particle.style.opacity = '0';
  }

  function animate(particle) {
    place(particle);
    const duration = Math.random() * 10 + 10;
    const delay = Math.random() * 2;
    setTimeout(() => {
      particle.style.transition = `all ${duration}s linear`;
      particle.style.opacity = String(Math.random() * 0.3 + 0.1);
      particle.style.left = `${Math.random() * 100}%`;
      particle.style.top = `${Math.random() * 70}%`;
      setTimeout(() => animate(particle), duration * 1000);
    }, delay * 1000);
  }

  for (let i = 0; i < count; i++) {
    const particle = document.createElement('div');
    particle.className = 'particle';
    const size = Math.random() * 3 + 1;
    particle.style.width = `${size}px`;
    particle.style.height = `${size}px`;
    container.appendChild(particle);
    animate(particle);
  }
})();
