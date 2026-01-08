export const renderNotFound = (root) => {
    root.innerHTML = `
        <div class="login-container">
            <div style="max-width: 500px; text-align: center;">
                <p class="auth-eyebrow" style="display: inline-block; margin-bottom: 20px;">404 Error</p>
                <h1 class="auth-title" style="font-size: 4rem; margin-bottom: 20px;">Page Not Found</h1>
                <p class="auth-lead" style="margin-bottom: 40px;">The page you requested doesn't exist or has been moved.</p>
                <a class="btn primary" href="/" data-link>Back to Home</a>
            </div>
        </div>
    `;
};
