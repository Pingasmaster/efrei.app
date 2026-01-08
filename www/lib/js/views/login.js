export const renderLogin = (root, { api, state, updateStatus, navigate }) => {
    root.innerHTML = `
        <section class="auth">
            <div class="auth-card">
                <p class="eyebrow">Welcome back</p>
                <h1>Sign in to Efrei.bet</h1>
                <p class="lead">Your points and bets are waiting. Let's see what's happening on campus today.</p>

                <form id="login-form" class="form">
                    <label class="field">
                        <span>Email</span>
                        <input type="email" name="email" autocomplete="email" placeholder="your.name@efrei.fr" required>
                    </label>
                    <label class="field">
                        <span>Password</span>
                        <input type="password" name="password" autocomplete="current-password" minlength="6" placeholder="Enter your password" required>
                    </label>
                    <button class="btn primary" type="submit">Sign in</button>
                    <div class="form-status" role="status" aria-live="polite"></div>
                </form>

                <p class="form-note">No account yet? <a href="/signup" data-link>Join the fun</a></p>
            </div>

            <aside class="auth-aside">
                <div class="aside-card">
                    <h2>Virtual Points</h2>
                    <p>Bet safely with points. No real money involved, just campus competition.</p>
                </div>
                <div class="aside-card">
                    <h2>Earn Rewards</h2>
                    <p>Win points and exchange them for homework help, AI queries, and more.</p>
                </div>
            </aside>
        </section>
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
