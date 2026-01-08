export const renderSignup = (root, { api, updateStatus, navigate }) => {
    root.innerHTML = `
        <div class="signup-container">
            <div class="signup-header">
                <p class="auth-eyebrow">Join Efrei.bet</p>
                <h1>START YOUR<br>BETTING JOURNEY</h1>
                <p class="lead">Get free points to start, bet on campus events, and win amazing rewards.</p>
            </div>

            <div class="signup-benefits left">
                <div class="benefit-card">
                    <div class="benefit-number">01</div>
                    <h3>Free Starting Points</h3>
                    <p>Every new member gets starter points to begin betting right away. No deposit required.</p>
                </div>
                <div class="benefit-card">
                    <div class="benefit-number">02</div>
                    <h3>Campus Community</h3>
                    <p>Join hundreds of Efrei students betting on what happens next on campus.</p>
                </div>
            </div>

            <div class="signup-form-wrapper">
                <form id="signup-form" class="form">
                    <label class="field">
                        <span>Name</span>
                        <input type="text" name="name" autocomplete="name" placeholder="Your full name" required>
                    </label>
                    <label class="field">
                        <span>Email</span>
                        <input type="email" name="email" autocomplete="email" placeholder="your.name@efrei.fr" required>
                    </label>
                    <label class="field">
                        <span>Password</span>
                        <input type="password" name="password" autocomplete="new-password" minlength="6" placeholder="Create a secure password" required>
                    </label>
                    <button class="btn primary" type="submit">Create Account</button>
                    <div class="form-status" role="status" aria-live="polite"></div>
                </form>
                <p class="form-note">Already have an account? <a href="/login" data-link>Sign in here</a></p>
            </div>

            <div class="signup-benefits right">
                <div class="benefit-card">
                    <div class="benefit-number">03</div>
                    <h3>Real Rewards</h3>
                    <p>Exchange your points for homework help, AI queries, priority support, and more.</p>
                </div>
                <div class="benefit-card">
                    <div class="benefit-number">04</div>
                    <h3>Safe & Fun</h3>
                    <p>No real money involved. Just friendly competition and exciting campus events.</p>
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
