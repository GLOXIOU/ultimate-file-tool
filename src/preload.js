const urlsToPreload = [
    "../src/compress/index.html",
    "../src/convert/index.html",
    "../src/dowload/index.html",
    "../src/other/index.html"
];
urlsToPreload.forEach(url => fetch(url, {cache: 'force-cache'}));

document.addEventListener("DOMContentLoaded", () => {
    document.querySelectorAll("a.preload-link").forEach(link => {
        link.addEventListener("click", function(e) {
            e.preventDefault();
            const url = this.getAttribute("href");
            const overlay = document.getElementById("fade-overlay");
            overlay.style.transition = "opacity 1.5s";
            overlay.style.display = "block";
            overlay.offsetHeight; // force reflow
            overlay.style.opacity = "1";
            setTimeout(() => {
                window.location.href = url;
            }, 1500);
        });
    });
    const openLink = document.getElementById('openLink');
    if (openLink) {
        openLink.addEventListener('click', (e) => {
            e.preventDefault();
            const link = e.target.closest('a');
            if (!link) return;
            window.electronAPI.openExternal(link.href);
        });
    }
});