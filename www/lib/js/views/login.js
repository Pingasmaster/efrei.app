export const renderLogin = (root, { api, state, navigate }) => {
    root.innerHTML = `
        <div class="login-container">
            <div class="login-wrapper">
                <div class="login-visual">
                    <div class="login-visual-content">
                        <h2>Bienvenue sur<br><span>Central E</span></h2>
                        <p>Votre portail etudiant unifie. Retrouvez votre emploi du temps, vos cours et vos taches en un seul endroit.</p>

                        <div class="login-features">
                            <div class="login-feature">
                                <div class="login-feature-icon">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <rect x="3" y="4" width="18" height="18" rx="2" ry="2"/>
                                        <line x1="16" y1="2" x2="16" y2="6"/>
                                        <line x1="8" y1="2" x2="8" y2="6"/>
                                        <line x1="3" y1="10" x2="21" y2="10"/>
                                    </svg>
                                </div>
                                <span>Emploi du temps en direct</span>
                            </div>
                            <div class="login-feature">
                                <div class="login-feature-icon">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                        <polyline points="14 2 14 8 20 8"/>
                                        <line x1="16" y1="13" x2="8" y2="13"/>
                                        <line x1="16" y1="17" x2="8" y2="17"/>
                                    </svg>
                                </div>
                                <span>Taches Moodle et Teams</span>
                            </div>
                            <div class="login-feature">
                                <div class="login-feature-icon">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                                        <polyline points="15 3 21 3 21 9"/>
                                        <line x1="10" y1="14" x2="21" y2="3"/>
                                    </svg>
                                </div>
                                <span>Acces rapide aux cours</span>
                            </div>
                        </div>
                    </div>
                </div>

                <div class="login-form-panel">
                    <div class="auth-header">
                        <span class="auth-badge">Content de vous revoir</span>
                        <h1>Connexion</h1>
                        <p>Entrez vos identifiants pour acceder a votre espace</p>
                    </div>

                    <form id="login-form" class="form">
                        <label class="field">
                            <span>Email</span>
                            <input type="email" name="email" autocomplete="email" placeholder="vous@efrei.fr" required>
                        </label>
                        <label class="field">
                            <span>Mot de passe</span>
                            <input type="password" name="password" autocomplete="current-password" minlength="6" placeholder="Votre mot de passe" required>
                        </label>
                        <button class="btn primary" type="submit">Se connecter</button>
                        <div class="form-status" role="status" aria-live="polite"></div>
                    </form>

                    <p class="form-note">Pas encore de compte? <a href="/signup" data-link>Creer un compte</a></p>
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
        submit.textContent = "Connexion...";

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
            setStatus("Connexion reussie!", "success");
            if (typeof navigate === "function") {
                setTimeout(() => navigate("/dashboard"), 600);
            }
        } catch (error) {
            setStatus(error.message || "Echec de la connexion. Veuillez reessayer.", "error");
        } finally {
            submit.disabled = false;
            submit.textContent = submit.dataset.originalText || "Se connecter";
        }
    });
};
