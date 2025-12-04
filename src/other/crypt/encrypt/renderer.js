document.addEventListener("DOMContentLoaded", () => {
    const overlay = document.getElementById("fade-overlay");
    overlay.style.opacity = "1";
    overlay.style.transition = "opacity 1.5s";
    setTimeout(() => {
        overlay.style.opacity = "0";
    }, 10);
    setTimeout(() => {
        overlay.style.display = "none";
    }, 1510);
    const particlesContainer = document.getElementById('particles-container');
    const particleCount = 80;
    for (let i = 0; i < particleCount; i++) {
        createParticleReady(particlesContainer);
    }
    function createParticleReady(particlesContainer) {
        const particle = document.createElement('div');
        particle.className = 'particle';
        const size = Math.random() * 3 + 1;
        particle.style.width = `${size}px`;
        particle.style.height = `${size}px`;
        resetParticle(particle);
        particlesContainer.appendChild(particle);
        animateParticle(particle);
    }
    function resetParticle(particle) {
        particle.style.left = `${Math.random() * 100}%`;
        particle.style.top = `${Math.random() * 100}%`;
        particle.style.opacity = '0';
    }
    function animateParticle(particle) {
        resetParticle(particle);
        const duration = Math.random() * 10 + 10;
        const delay = Math.random() * 2;
        setTimeout(() => {
            particle.style.transition = `all ${duration}s linear`;
            particle.style.opacity = Math.random() * 0.3 + 0.1;
            particle.style.left = `${Math.random() * 100}%`;
            particle.style.top = `${Math.random() * 70}%`;
            setTimeout(() => animateParticle(particle), duration * 1000);
        }, delay * 1000);
    }

    document.getElementById("encrypt").addEventListener("click", (event) => {
        
    })
});