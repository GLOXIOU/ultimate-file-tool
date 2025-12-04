document.addEventListener("DOMContentLoaded", () => {
    let particlesReady = false;
    let baseReady = false;
    let allReady = false;
    let shown = false;
    function onReady() {
        if (allReady || shown) return;
        allReady = true;
        document.getElementById("loader-container").style.opacity = "0";
        setTimeout(() => {
            document.getElementById("loader-container").style.display = "none";
            showFade();
        }, 750);
    }
    function showFade() {
        const overlay = document.getElementById("fade-overlay");
        overlay.style.transition = "opacity 1.5s";
        overlay.style.opacity = "0";
        setTimeout(() => {
            overlay.style.display = "none";
        }, 1500);
    }
    const overlay = document.getElementById("fade-overlay");
    overlay.style.opacity = "1";
    overlay.style.display = "block";
    overlay.style.transition = "opacity 1.5s";
    const particlesContainer = document.getElementById('particles-container');
    const particleCount = 80;
    let particlesLoaded = 0;
    function createParticleReady(particlesContainer, doneCallback) {
        const particle = document.createElement('div');
        particle.className = 'particle';
        const size = Math.random() * 3 + 1;
        particle.style.width = `${size}px`;
        particle.style.height = `${size}px`;
        resetParticle(particle);
        particlesContainer.appendChild(particle);
        animateParticle(particle, doneCallback);
    }
    function resetParticle(particle) {
        particle.style.left = `${Math.random() * 100}%`;
        particle.style.top = `${Math.random() * 100}%`;
        particle.style.opacity = '0';
    }
    function animateParticle(particle, readyCallback) {
        resetParticle(particle);
        const duration = Math.random() * 10 + 10;
        const delay = Math.random() * 2;
        setTimeout(() => {
            particle.style.transition = `all ${duration}s linear`;
            particle.style.opacity = Math.random() * 0.3 + 0.1;
            particle.style.left = `${Math.random() * 100}%`;
            particle.style.top = `${Math.random() * 70}%`;
            if (readyCallback) readyCallback();
            setTimeout(() => animateParticle(particle), duration * 1000);
        }, delay * 1000);
    }
    function particlesInit() {
        for (let i = 0; i < particleCount; i++) {
            createParticleReady(particlesContainer, () => {
                particlesLoaded++;
                if (particlesLoaded === particleCount && !particlesReady) {
                    particlesReady = true;
                    checkDone();
                }
            });
        }
    }
    function baseInit() {
        setTimeout(() => {
            baseReady = true;
            checkDone();
        }, 600);
    }
    function checkDone() {
        if (particlesReady && baseReady) onReady();
    }
    particlesInit();
    baseInit();
    document.getElementById('openLink').addEventListener('click', (e) => {
        e.preventDefault();
        const link = e.target.closest('a');
        if (!link) return;
        window.electronAPI.openExternal(link.href);
    });
});