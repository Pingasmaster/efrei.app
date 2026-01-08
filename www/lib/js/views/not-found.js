export const renderNotFound = (root) => {
    root.innerHTML = `
        <section class="auth">
            <div class="auth-card">
                <p class="eyebrow">404</p>
                <h1>Page not found</h1>
                <p class="lead">The page you requested doesn't exist.</p>
                <a class="btn primary" href="/" data-link>Go back home</a>
            </div>
        </section>
    `;
};
