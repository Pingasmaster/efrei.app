export const renderLogin = (root, { api, state, updateStatus, navigate }) => {
    root.innerHTML = `
        <section class="auth">
            <div class="auth-card">
                <p class="eyebrow">Welcome back</p>
                <h1>Sign in</h1>
                <p class="lead">Access your containerized workspace in seconds.</p>

                <form id="login-form" class="form">
                    <label class="field">
                        <span>Email</span>
                        <input type="email" name="email" autocomplete="email" required>
                    </label>
                    <label class="field">
                        <span>Password</span>
                        <input type="password" name="password" autocomplete="current-password" minlength="6" required>
                    </label>
                    <button class="btn primary" type="submit">Sign in</button>
                    <div class="form-status" role="status" aria-live="polite"></div>
                </form>

                <p class="form-note">No account yet? <a href="/signup" data-link>Create one</a>.</p>
            </div>

            <aside class="auth-aside">
                <div class="aside-card">
                    <h2>Compose-only workflow</h2>
                    <p>Keep everything reproducible with Docker Compose at the core.</p>
                </div>
                <div class="aside-card">
                    <h2>Secure gateway</h2>
                    <p>JWT-based login with a gateway entry point to scale fast.</p>
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
