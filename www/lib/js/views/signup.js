export const renderSignup = (root, { api, state, updateStatus, navigate }) => {
    root.innerHTML = `
        <div class="signup-container">
            <div class="signup-header">
                <span class="auth-badge">Join the Platform</span>
                <h1>Start Your<br><span>Betting Journey</span></h1>
                <p>Create an account and get 1000 free points to start betting on campus events.</p>
            </div>

            <div class="signup-content">
                <div class="signup-benefits left">
                    <div class="benefit-card">
                        <div class="benefit-number">01</div>
                        <h3>Free Starting Points</h3>
                        <p>Every new member gets 1000 points to start betting right away. No deposit required.</p>
                    </div>
                    <div class="benefit-card">
                        <div class="benefit-number">02</div>
                        <h3>Campus Community</h3>
                        <p>Join students betting on campus events, from exam results to daily happenings.</p>
                    </div>
                </div>

                <div class="signup-form-wrapper">
                    <form id="signup-form" class="form">
                        <label class="field">
                            <span>Full Name</span>
                            <input type="text" name="name" autocomplete="name" placeholder="Your name" required>
                        </label>
                        <label class="field">
                            <span>Email</span>
                            <input type="email" name="email" autocomplete="email" placeholder="you@efrei.fr" required>
                        </label>
                        <label class="field">
                            <span>Password</span>
                            <input type="password" name="password" autocomplete="new-password" minlength="6" placeholder="Create a password" required>
                        </label>
                        <button class="btn primary" type="submit">Create Account</button>
                        <div class="form-status" role="status" aria-live="polite"></div>
                    </form>
                    <p class="form-note">Already have an account? <a href="/login" data-link>Sign in</a></p>
                </div>

                <div class="signup-benefits right">
                    <div class="benefit-card">
                        <div class="benefit-number">03</div>
                        <h3>Real Rewards</h3>
                        <p>Exchange your points for homework help, AI queries, priority support, and more.</p>
                    </div>
                    <div class="benefit-card">
                        <div class="benefit-number">04</div>
                        <h3>Safe and Fun</h3>
                        <p>No real money involved. Just friendly competition and exciting campus events.</p>
                    </div>
                </div>
            </div>
        </div>
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
        submit.textContent = "Creating account...";

        const formData = new FormData(form);
        try {
            const data = await api.register({
                name: formData.get("name"),
                email: formData.get("email"),
                password: formData.get("password")
            });
            if (data?.token && typeof state?.setToken === "function") {
                state.setToken(data.token);
                if (data?.refreshToken && typeof state?.setRefreshToken === "function") {
                    state.setRefreshToken(data.refreshToken);
                }
                updateStatus?.();
                setStatus("Account created successfully!", "success");
                if (typeof navigate === "function") {
                    setTimeout(() => navigate("/"), 600);
                }
            } else {
                setStatus("Account created! You can now sign in.", "success");
                if (typeof navigate === "function") {
                    setTimeout(() => navigate("/login"), 800);
                }
            }
        } catch (error) {
            setStatus(error.message || "Signup failed. Please try again.", "error");
        } finally {
            submit.disabled = false;
            submit.textContent = submit.dataset.originalText || "Create Account";
        }
    });
};
