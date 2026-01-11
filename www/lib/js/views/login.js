export const renderLogin = (root, { api, state, updateStatus, navigate }) => {
    root.innerHTML = `
        <div class="login-container">
            <div class="login-wrapper">
                <div class="login-visual">
                    <div class="login-visual-content">
                        <h2>Welcome to<br><span>Campus Betting</span></h2>
                        <p>Join the community of students betting on campus life. No real money, just points and rewards.</p>

                        <div class="login-features">
                            <div class="login-feature">
                                <div class="login-feature-icon">+</div>
                                <span>1000 free starting points</span>
                            </div>
                            <div class="login-feature">
                                <div class="login-feature-icon">*</div>
                                <span>Real-time live odds</span>
                            </div>
                            <div class="login-feature">
                                <div class="login-feature-icon">></div>
                                <span>Redeem for real rewards</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="login-form-panel">
                    <div class="auth-header">
                        <span class="auth-badge">Welcome Back</span>
                        <h1>Sign In</h1>
                        <p>Enter your credentials to access your account</p>
                    </div>

                    <form id="login-form" class="form">
                        <label class="field">
                            <span>Email</span>
                            <input type="email" name="email" autocomplete="email" placeholder="you@efrei.fr" required>
                        </label>
                        <label class="field">
                            <span>Password</span>
                            <input type="password" name="password" autocomplete="current-password" minlength="6" placeholder="Enter your password" required>
                        </label>
                        <button class="btn primary" type="submit">Sign In</button>
                        <div class="form-status" role="status" aria-live="polite"></div>
                    </form>

                    <p class="form-note">Don't have an account? <a href="/signup" data-link>Create one</a></p>
                </div>
            </div>
        </div>
    `;

    const form = root.querySelector("#login-form");
    const status = form.querySelector(".form-status");
    const submit = form.querySelector("button[type=submit]");

    const setStatus = (message, variant) => {
        status.textContent = message;
        status.classList.remove("success", "error");
        if (variant) {
            status.classList.add(variant);
        }
    };

    form.addEventListener("submit", async (event) => {
        event.preventDefault();
        setStatus("");
        submit.disabled = true;
        submit.dataset.originalText = submit.dataset.originalText || submit.textContent;
        submit.textContent = "Signing in...";

        const formData = new FormData(form);
        try {
            const data = await api.login({
                email: formData.get("email"),
                password: formData.get("password")
            });
            if (data?.token) {
                state.setToken(data.token);
            }
            if (data?.refreshToken && typeof state.setRefreshToken === "function") {
                state.setRefreshToken(data.refreshToken);
            }
            setStatus("Signed in successfully!", "success");
            updateStatus();
            if (typeof navigate === "function") {
                setTimeout(() => navigate("/"), 600);
            }
        } catch (error) {
            setStatus(error.message || "Login failed. Please try again.", "error");
        } finally {
            submit.disabled = false;
            submit.textContent = submit.dataset.originalText || "Sign In";
        }
    });
};
