export const renderSignup = (root, { api, updateStatus, navigate }) => {
    root.innerHTML = `
        <section class="auth">
            <div class="auth-card">
                <p class="eyebrow">New here?</p>
                <h1>Create your account</h1>
                <p class="lead">Get a clean Docker-first stack in minutes.</p>

                <form id="signup-form" class="form">
                    <label class="field">
                        <span>Name</span>
                        <input type="text" name="name" autocomplete="name" required>
                    </label>
                    <label class="field">
                        <span>Email</span>
                        <input type="email" name="email" autocomplete="email" required>
                    </label>
                    <label class="field">
                        <span>Password</span>
                        <input type="password" name="password" autocomplete="new-password" minlength="6" required>
                    </label>
                    <button class="btn primary" type="submit">Create account</button>
                    <div class="form-status" role="status" aria-live="polite"></div>
                </form>

                <p class="form-note">Already have an account? <a href="/login" data-link>Sign in</a>.</p>
            </div>

            <aside class="auth-aside">
                <div class="aside-card">
                    <h2>Offline ready</h2>
                    <p>Static assets are cached so the UI works without a network.</p>
                </div>
                <div class="aside-card">
                    <h2>Extend quickly</h2>
                    <p>Plug in your real logic and database calls when you are ready.</p>
                </div>
            </aside>
        </section>
    `;

    const form = root.querySelector("#signup-form");
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
            await api.register({
                name: formData.get("name"),
                email: formData.get("email"),
                password: formData.get("password")
            });
            setStatus("Account created. You can now sign in.", "success");
            if (typeof navigate === "function") {
                setTimeout(() => navigate("/login"), 800);
            }
        } catch (error) {
            setStatus(error.message || "Signup failed.", "error");
        } finally {
            submit.disabled = false;
            submit.textContent = submit.dataset.originalText || "Create account";
        }
    });
};
