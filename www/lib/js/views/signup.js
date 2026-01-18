export const renderSignup = (root, { api, state, navigate }) => {
    root.innerHTML = `
        <div class="signup-container">
            <div class="signup-header">
                <span class="auth-badge">Rejoindre la plateforme</span>
                <h1>Commencez votre<br><span>experience Central E</span></h1>
                <p>Creez un compte et accedez a toutes vos ressources EFREI en un seul endroit.</p>
            </div>

            <div class="signup-content">
                <div class="signup-benefits left">
                    <div class="benefit-card">
                        <div class="benefit-number">01</div>
                        <h3>Emploi du temps</h3>
                        <p>Consultez votre prochain cours en un clin d'oeil avec toutes les informations essentielles.</p>
                    </div>
                    <div class="benefit-card">
                        <div class="benefit-number">02</div>
                        <h3>Taches reunies</h3>
                        <p>Retrouvez tous vos devoirs Moodle et Teams au meme endroit, avec leurs echeances.</p>
                    </div>
                </div>

                <div class="signup-form-wrapper">
                    <form id="signup-form" class="form">
                        <label class="field">
                            <span>Nom complet</span>
                            <input type="text" name="name" autocomplete="name" placeholder="Votre nom" required>
                        </label>
                        <label class="field">
                            <span>Email</span>
                            <input type="email" name="email" autocomplete="email" placeholder="vous@efrei.fr" required>
                        </label>
                        <label class="field">
                            <span>Mot de passe</span>
                            <input type="password" name="password" autocomplete="new-password" minlength="6" placeholder="Creez un mot de passe" required>
                        </label>
                        <button class="btn primary" type="submit">Creer mon compte</button>
                        <div class="form-status" role="status" aria-live="polite"></div>
                    </form>
                    <p class="form-note">Deja un compte? <a href="/login" data-link>Se connecter</a></p>
                </div>

                <div class="signup-benefits right">
                    <div class="benefit-card">
                        <div class="benefit-number">03</div>
                        <h3>Acces rapide</h3>
                        <p>Ouvrez directement Moodle et Teams depuis chaque cours en un seul clic.</p>
                    </div>
                    <div class="benefit-card">
                        <div class="benefit-number">04</div>
                        <h3>Vue d'ensemble</h3>
                        <p>Gardez une vue complete sur votre journee et vos prochaines echeances.</p>
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
        submit.textContent = "Creation en cours...";

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
                setStatus("Compte cree avec succes!", "success");

                // Trigger onboarding for new users
                state.setShowOnboarding(true);

                if (typeof navigate === "function") {
                    setTimeout(() => navigate("/dashboard"), 600);
                }
            } else {
                setStatus("Compte cree! Vous pouvez maintenant vous connecter.", "success");
                if (typeof navigate === "function") {
                    setTimeout(() => navigate("/login"), 800);
                }
            }
        } catch (error) {
            setStatus(error.message || "Echec de l'inscription. Veuillez reessayer.", "error");
        } finally {
            submit.disabled = false;
            submit.textContent = submit.dataset.originalText || "Creer mon compte";
        }
    });
};
