export const renderLogin = (root, { api, state, updateStatus, navigate }) => {
    root.innerHTML = `
        <div class="login-container">
            <div class="login-wrapper">
                <div class="login-main">
                    <p class="auth-eyebrow">Welcome Back</p>
                    <h1 class="auth-title">Sign In</h1>
                    <p class="auth-lead">Your points and bets are waiting. Let's see what's happening on campus today.</p>

                    <form id="login-form" class="form">
                        <label class="field">
                            <span>Email</span>
                            <input type="email" name="email" autocomplete="email" placeholder="your.name@efrei.fr" required>
                        </label>
                        <label class="field">
                            <span>Password</span>
                            <input type="password" name="password" autocomplete="current-password" minlength="6" placeholder="Enter your password" required>
                        </label>
                        <button class="btn primary" type="submit">Sign In</button>
                        <div class="form-status" role="status" aria-live="polite"></div>
                    </form>

                    <p class="form-note">No account yet? <a href="/signup" data-link>Join the fun</a></p>
                </div>

                <div class="login-accent">
                    <div class="accent-content">
                        <h2>Campus Betting</h2>
                        <div class="accent-feature">
                            <h3>Virtual Points</h3>
                            <p>Bet safely with points. No real money involved, just campus competition.</p>
                        </div>
                        <div class="accent-feature">
                            <h3>Earn Rewards</h3>
                            <p>Win points and exchange them for homework help, AI queries, and more.</p>
                        </div>
                    </div>
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
        submit.textContent = "Please wait...";

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
            setStatus("Signed in successfully.", "success");
            updateStatus();
            if (typeof navigate === "function") {
                setTimeout(() => navigate("/"), 600);
            }
        } catch (error) {
            setStatus(error.message || "Login failed.", "error");
        } finally {
            submit.disabled = false;
            submit.textContent = submit.dataset.originalText || "Sign in";
        }
    });
};
