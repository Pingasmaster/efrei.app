// Settings page with theme, profile, and security options
export const renderSettings = (root, { api, state, navigate }) => {
    // Load settings from localStorage
    let theme = localStorage.getItem('efrei_theme') || 'system';
    let nickname = localStorage.getItem('efrei_nickname') || '';
    let biography = localStorage.getItem('efrei_biography') || '';
    let quote = localStorage.getItem('efrei_quote') || '';
    let profileVisibility = localStorage.getItem('efrei_profile_visibility') || 'public';

    // Security settings
    let authMethod = localStorage.getItem('efrei_auth_method') || 'password'; // password, passkey, password_2fa
    let totpEnabled = localStorage.getItem('efrei_totp_enabled') === 'true';
    let passkeysRegistered = JSON.parse(localStorage.getItem('efrei_passkeys') || '[]');

    // UI state
    let activeTab = 'appearance';
    let showTotpSetup = false;
    let totpSecret = null;
    let totpQrCode = null;
    let saveStatus = '';
    let saveStatusType = '';

    const render = () => {
        root.innerHTML = `
            <div class="settings-container">
                <div class="settings-header">
                    <h1>Parametres</h1>
                    <p>Personnalisez votre experience Central E</p>
                </div>

                <div class="settings-layout">
                    <nav class="settings-nav glass-card">
                        <button class="settings-nav-item ${activeTab === 'appearance' ? 'active' : ''}" data-tab="appearance">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="5"/>
                                <line x1="12" y1="1" x2="12" y2="3"/>
                                <line x1="12" y1="21" x2="12" y2="23"/>
                                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                                <line x1="1" y1="12" x2="3" y2="12"/>
                                <line x1="21" y1="12" x2="23" y2="12"/>
                                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                            </svg>
                            Apparence
                        </button>
                        <button class="settings-nav-item ${activeTab === 'profile' ? 'active' : ''}" data-tab="profile">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                                <circle cx="12" cy="7" r="4"/>
                            </svg>
                            Profil
                        </button>
                        <button class="settings-nav-item ${activeTab === 'security' ? 'active' : ''}" data-tab="security">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                            </svg>
                            Securite
                        </button>
                        <button class="settings-nav-item ${activeTab === 'notifications' ? 'active' : ''}" data-tab="notifications">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                                <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                            </svg>
                            Notifications
                        </button>
                        <button class="settings-nav-item ${activeTab === 'data' ? 'active' : ''}" data-tab="data">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <ellipse cx="12" cy="5" rx="9" ry="3"/>
                                <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
                                <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
                            </svg>
                            Donnees
                        </button>
                    </nav>

                    <div class="settings-content glass-card">
                        ${renderTabContent()}
                    </div>
                </div>

                ${saveStatus ? `
                    <div class="settings-toast ${saveStatusType}">
                        ${saveStatus}
                    </div>
                ` : ''}
            </div>
        `;

        attachEventListeners();
    };

    const renderTabContent = () => {
        switch (activeTab) {
            case 'appearance':
                return renderAppearanceTab();
            case 'profile':
                return renderProfileTab();
            case 'security':
                return renderSecurityTab();
            case 'notifications':
                return renderNotificationsTab();
            case 'data':
                return renderDataTab();
            default:
                return renderAppearanceTab();
        }
    };

    const renderAppearanceTab = () => {
        return `
            <div class="settings-section">
                <h2>Theme</h2>
                <p class="section-description">Choisissez le theme de l'interface</p>

                <div class="theme-options">
                    <label class="theme-option ${theme === 'system' ? 'selected' : ''}" data-theme="system">
                        <input type="radio" name="theme" value="system" ${theme === 'system' ? 'checked' : ''}>
                        <div class="theme-preview system">
                            <div class="preview-header"></div>
                            <div class="preview-content">
                                <div class="preview-sidebar"></div>
                                <div class="preview-main"></div>
                            </div>
                        </div>
                        <span class="theme-label">Systeme</span>
                        <span class="theme-desc">Suit les preferences de votre appareil</span>
                    </label>

                    <label class="theme-option ${theme === 'dark' ? 'selected' : ''}" data-theme="dark">
                        <input type="radio" name="theme" value="dark" ${theme === 'dark' ? 'checked' : ''}>
                        <div class="theme-preview dark">
                            <div class="preview-header"></div>
                            <div class="preview-content">
                                <div class="preview-sidebar"></div>
                                <div class="preview-main"></div>
                            </div>
                        </div>
                        <span class="theme-label">Sombre</span>
                        <span class="theme-desc">Interface sombre pour reduire la fatigue oculaire</span>
                    </label>

                    <label class="theme-option ${theme === 'light' ? 'selected' : ''}" data-theme="light">
                        <input type="radio" name="theme" value="light" ${theme === 'light' ? 'checked' : ''}>
                        <div class="theme-preview light">
                            <div class="preview-header"></div>
                            <div class="preview-content">
                                <div class="preview-sidebar"></div>
                                <div class="preview-main"></div>
                            </div>
                        </div>
                        <span class="theme-label">Clair</span>
                        <span class="theme-desc">Interface claire et lumineuse</span>
                    </label>
                </div>
            </div>

            <div class="settings-section">
                <h2>Accent</h2>
                <p class="section-description">Couleur principale de l'interface (bientot disponible)</p>

                <div class="accent-colors">
                    <button class="accent-color cyan selected" data-accent="cyan" title="Cyan"></button>
                    <button class="accent-color purple" data-accent="purple" title="Violet" disabled></button>
                    <button class="accent-color green" data-accent="green" title="Vert" disabled></button>
                    <button class="accent-color orange" data-accent="orange" title="Orange" disabled></button>
                    <button class="accent-color pink" data-accent="pink" title="Rose" disabled></button>
                </div>
            </div>
        `;
    };

    const renderProfileTab = () => {
        return `
            <div class="settings-section">
                <h2>Informations du profil</h2>
                <p class="section-description">Ces informations seront visibles sur votre profil public</p>

                <form id="profile-form" class="settings-form">
                    <label class="field">
                        <span>Surnom / Pseudonyme</span>
                        <input type="text" id="nickname" value="${escapeHtml(nickname)}" placeholder="Votre surnom (optionnel)" maxlength="50">
                        <small>Sera affiche a la place de votre nom reel si defini</small>
                    </label>

                    <label class="field">
                        <span>Biographie</span>
                        <textarea id="biography" rows="4" placeholder="Parlez de vous..." maxlength="500">${escapeHtml(biography)}</textarea>
                        <small>${biography.length}/500 caracteres</small>
                    </label>

                    <label class="field">
                        <span>Citation</span>
                        <input type="text" id="quote" value="${escapeHtml(quote)}" placeholder="Votre citation favorite" maxlength="200">
                        <small>Une citation inspirante ou amusante</small>
                    </label>

                    <div class="field">
                        <span>Visibilite du profil</span>
                        <div class="radio-group">
                            <label class="radio-option">
                                <input type="radio" name="visibility" value="public" ${profileVisibility === 'public' ? 'checked' : ''}>
                                <div class="radio-content">
                                    <strong>Public</strong>
                                    <span>Tout le monde peut voir votre profil</span>
                                </div>
                            </label>
                            <label class="radio-option">
                                <input type="radio" name="visibility" value="private" ${profileVisibility === 'private' ? 'checked' : ''}>
                                <div class="radio-content">
                                    <strong>Prive</strong>
                                    <span>Seuls les administrateurs peuvent voir votre profil</span>
                                </div>
                            </label>
                        </div>
                    </div>

                    <div class="form-actions">
                        <button type="submit" class="btn primary">Enregistrer le profil</button>
                    </div>
                </form>
            </div>

            <div class="settings-section">
                <h2>Apercu du profil</h2>
                <div class="profile-preview glass-card">
                    <div class="preview-avatar">
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                            <circle cx="12" cy="7" r="4"/>
                        </svg>
                    </div>
                    <div class="preview-info">
                        <h3>${nickname || 'Votre nom'}</h3>
                        ${quote ? `<p class="preview-quote">"${escapeHtml(quote)}"</p>` : ''}
                        <p class="preview-bio">${biography || 'Aucune biographie'}</p>
                    </div>
                </div>
            </div>
        `;
    };

    const renderSecurityTab = () => {
        return `
            <div class="settings-section">
                <h2>Methode d'authentification</h2>
                <p class="section-description">Choisissez comment vous souhaitez vous connecter</p>

                <div class="auth-methods">
                    <label class="auth-method ${authMethod === 'password' ? 'selected' : ''}">
                        <input type="radio" name="auth-method" value="password" ${authMethod === 'password' ? 'checked' : ''}>
                        <div class="auth-method-icon">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                                <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                            </svg>
                        </div>
                        <div class="auth-method-info">
                            <strong>Mot de passe</strong>
                            <span>Connexion classique avec email et mot de passe</span>
                        </div>
                    </label>

                    <label class="auth-method ${authMethod === 'passkey' ? 'selected' : ''}">
                        <input type="radio" name="auth-method" value="passkey" ${authMethod === 'passkey' ? 'checked' : ''}>
                        <div class="auth-method-icon">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 2a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2 2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/>
                                <path d="M12 8a4 4 0 0 1 4 4v8H8v-8a4 4 0 0 1 4-4z"/>
                                <path d="M8 20h8"/>
                            </svg>
                        </div>
                        <div class="auth-method-info">
                            <strong>Passkey</strong>
                            <span>Connexion sans mot de passe avec Face ID, Touch ID ou cle de securite</span>
                        </div>
                        <span class="auth-badge">Recommande</span>
                    </label>

                    <label class="auth-method ${authMethod === 'password_2fa' ? 'selected' : ''}">
                        <input type="radio" name="auth-method" value="password_2fa" ${authMethod === 'password_2fa' ? 'checked' : ''}>
                        <div class="auth-method-icon">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>
                                <path d="M12 8v4"/>
                                <path d="M12 16h.01"/>
                            </svg>
                        </div>
                        <div class="auth-method-info">
                            <strong>Mot de passe + 2FA</strong>
                            <span>Connexion renforcee avec code TOTP (Google Authenticator, etc.)</span>
                        </div>
                    </label>
                </div>
            </div>

            ${authMethod === 'passkey' ? renderPasskeySection() : ''}
            ${authMethod === 'password_2fa' ? renderTotpSection() : ''}

            <div class="settings-section">
                <h2>Changer le mot de passe</h2>
                <form id="password-form" class="settings-form">
                    <label class="field">
                        <span>Mot de passe actuel</span>
                        <input type="password" id="current-password" autocomplete="current-password">
                    </label>
                    <label class="field">
                        <span>Nouveau mot de passe</span>
                        <input type="password" id="new-password" autocomplete="new-password" minlength="6">
                    </label>
                    <label class="field">
                        <span>Confirmer le nouveau mot de passe</span>
                        <input type="password" id="confirm-password" autocomplete="new-password">
                    </label>
                    <div class="form-actions">
                        <button type="submit" class="btn primary">Changer le mot de passe</button>
                    </div>
                </form>
            </div>

            <div class="settings-section danger-zone">
                <h2>Sessions actives</h2>
                <p class="section-description">Gerez vos sessions connectees</p>
                <button class="btn ghost" id="logout-all">Deconnecter toutes les sessions</button>
            </div>
        `;
    };

    const renderPasskeySection = () => {
        return `
            <div class="settings-section">
                <h2>Passkeys enregistrees</h2>
                <p class="section-description">Gerez vos cles d'authentification</p>

                ${passkeysRegistered.length > 0 ? `
                    <div class="passkey-list">
                        ${passkeysRegistered.map((pk, index) => `
                            <div class="passkey-item">
                                <div class="passkey-icon">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M12 2a2 2 0 0 1 2 2v1a2 2 0 0 1-2 2 2 2 0 0 1-2-2V4a2 2 0 0 1 2-2z"/>
                                        <path d="M12 8a4 4 0 0 1 4 4v8H8v-8a4 4 0 0 1 4-4z"/>
                                    </svg>
                                </div>
                                <div class="passkey-info">
                                    <strong>${pk.name || 'Passkey ' + (index + 1)}</strong>
                                    <span>Ajoutee le ${formatDate(pk.createdAt)}</span>
                                </div>
                                <button class="btn ghost small remove-passkey" data-index="${index}">Supprimer</button>
                            </div>
                        `).join('')}
                    </div>
                ` : `
                    <div class="empty-state">
                        <p>Aucune passkey enregistree</p>
                    </div>
                `}

                <button class="btn primary" id="register-passkey">
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="12" y1="5" x2="12" y2="19"/>
                        <line x1="5" y1="12" x2="19" y2="12"/>
                    </svg>
                    Ajouter une passkey
                </button>
            </div>
        `;
    };

    const renderTotpSection = () => {
        return `
            <div class="settings-section">
                <h2>Authentification a deux facteurs (2FA)</h2>
                <p class="section-description">Protegez votre compte avec un code TOTP</p>

                ${totpEnabled ? `
                    <div class="totp-status enabled">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
                            <polyline points="22 4 12 14.01 9 11.01"/>
                        </svg>
                        <div>
                            <strong>2FA active</strong>
                            <span>Votre compte est protege par un code TOTP</span>
                        </div>
                        <button class="btn ghost" id="disable-totp">Desactiver</button>
                    </div>
                ` : showTotpSetup ? renderTotpSetup() : `
                    <div class="totp-status disabled">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="12" y1="8" x2="12" y2="12"/>
                            <line x1="12" y1="16" x2="12.01" y2="16"/>
                        </svg>
                        <div>
                            <strong>2FA desactive</strong>
                            <span>Activez la 2FA pour renforcer la securite de votre compte</span>
                        </div>
                        <button class="btn primary" id="enable-totp">Activer la 2FA</button>
                    </div>
                `}
            </div>
        `;
    };

    const renderTotpSetup = () => {
        // Generate a mock TOTP secret (in real implementation, this comes from backend)
        if (!totpSecret) {
            totpSecret = generateMockTotpSecret();
            totpQrCode = `otpauth://totp/CentralE:user@efrei.fr?secret=${totpSecret}&issuer=CentralE`;
        }

        return `
            <div class="totp-setup">
                <div class="totp-step">
                    <span class="step-number">1</span>
                    <div class="step-content">
                        <h4>Scannez le QR code</h4>
                        <p>Utilisez une application d'authentification comme Google Authenticator, Authy ou 1Password</p>
                        <div class="qr-placeholder">
                            <div class="qr-code">
                                <svg width="150" height="150" viewBox="0 0 150 150">
                                    <rect fill="white" width="150" height="150"/>
                                    <text x="75" y="75" text-anchor="middle" fill="#333" font-size="12">QR Code</text>
                                    <text x="75" y="90" text-anchor="middle" fill="#666" font-size="10">(Simulation)</text>
                                </svg>
                            </div>
                            <p class="qr-note">Ou entrez manuellement: <code>${totpSecret}</code></p>
                        </div>
                    </div>
                </div>

                <div class="totp-step">
                    <span class="step-number">2</span>
                    <div class="step-content">
                        <h4>Verifiez le code</h4>
                        <p>Entrez le code a 6 chiffres affiche dans votre application</p>
                        <div class="totp-input-group">
                            <input type="text" id="totp-code" maxlength="6" placeholder="000000" pattern="[0-9]{6}">
                            <button class="btn primary" id="verify-totp">Verifier</button>
                        </div>
                    </div>
                </div>

                <button class="btn ghost" id="cancel-totp-setup">Annuler</button>
            </div>
        `;
    };

    const renderNotificationsTab = () => {
        return `
            <div class="settings-section">
                <h2>Preferences de notifications</h2>
                <p class="section-description">Gerez les notifications que vous recevez</p>

                <div class="notification-options">
                    <label class="toggle-option">
                        <div class="toggle-info">
                            <strong>Nouveaux devoirs</strong>
                            <span>Etre notifie quand un nouveau devoir est ajoute</span>
                        </div>
                        <input type="checkbox" checked>
                        <span class="toggle-switch"></span>
                    </label>

                    <label class="toggle-option">
                        <div class="toggle-info">
                            <strong>Rappels d'echeances</strong>
                            <span>Rappels avant la date limite des devoirs</span>
                        </div>
                        <input type="checkbox" checked>
                        <span class="toggle-switch"></span>
                    </label>

                    <label class="toggle-option">
                        <div class="toggle-info">
                            <strong>Changements d'emploi du temps</strong>
                            <span>Etre notifie des modifications de cours</span>
                        </div>
                        <input type="checkbox" checked>
                        <span class="toggle-switch"></span>
                    </label>

                    <label class="toggle-option">
                        <div class="toggle-info">
                            <strong>Notifications par email</strong>
                            <span>Recevoir un resume hebdomadaire par email</span>
                        </div>
                        <input type="checkbox">
                        <span class="toggle-switch"></span>
                    </label>
                </div>
            </div>
        `;
    };

    const renderDataTab = () => {
        return `
            <div class="settings-section">
                <h2>Vos donnees</h2>
                <p class="section-description">Gerez vos donnees personnelles</p>

                <div class="data-actions">
                    <div class="data-action">
                        <div class="data-action-icon">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
                                <polyline points="7 10 12 15 17 10"/>
                                <line x1="12" y1="15" x2="12" y2="3"/>
                            </svg>
                        </div>
                        <div class="data-action-info">
                            <strong>Exporter mes donnees</strong>
                            <span>Telechargez une copie de toutes vos donnees</span>
                        </div>
                        <button class="btn ghost" id="export-data">Exporter</button>
                    </div>

                    <div class="data-action">
                        <div class="data-action-icon">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"/>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                            </svg>
                        </div>
                        <div class="data-action-info">
                            <strong>Effacer les donnees locales</strong>
                            <span>Supprime les preferences et le cache local</span>
                        </div>
                        <button class="btn ghost" id="clear-local-data">Effacer</button>
                    </div>
                </div>
            </div>

            <div class="settings-section danger-zone">
                <h2>Zone de danger</h2>
                <p class="section-description">Actions irreversibles</p>

                <div class="danger-action">
                    <div class="danger-action-info">
                        <strong>Supprimer mon compte</strong>
                        <span>Cette action est irreversible. Toutes vos donnees seront supprimees.</span>
                    </div>
                    <button class="btn danger" id="delete-account">Supprimer le compte</button>
                </div>
            </div>
        `;
    };

    const escapeHtml = (text) => {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    };

    const formatDate = (dateStr) => {
        const date = new Date(dateStr);
        return date.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', year: 'numeric' });
    };

    const generateMockTotpSecret = () => {
        const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
        let secret = '';
        for (let i = 0; i < 16; i++) {
            secret += chars[Math.floor(Math.random() * chars.length)];
        }
        return secret;
    };

    const showSaveStatus = (message, type = 'success') => {
        saveStatus = message;
        saveStatusType = type;
        render();

        setTimeout(() => {
            saveStatus = '';
            saveStatusType = '';
            render();
        }, 3000);
    };

    const applyTheme = (newTheme) => {
        theme = newTheme;
        localStorage.setItem('efrei_theme', theme);

        // Apply theme to document
        const root = document.documentElement;
        root.removeAttribute('data-theme');

        if (theme === 'light') {
            root.setAttribute('data-theme', 'light');
        } else if (theme === 'dark') {
            root.setAttribute('data-theme', 'dark');
        }
        // 'system' uses prefers-color-scheme media query

        render();
        showSaveStatus('Theme applique');
    };

    const attachEventListeners = () => {
        // Tab navigation
        const tabButtons = root.querySelectorAll('.settings-nav-item');
        tabButtons.forEach(btn => {
            btn.addEventListener('click', () => {
                activeTab = btn.dataset.tab;
                render();
            });
        });

        // Theme selection
        const themeInputs = root.querySelectorAll('input[name="theme"]');
        themeInputs.forEach(input => {
            input.addEventListener('change', () => {
                applyTheme(input.value);
            });
        });

        // Profile form
        const profileForm = root.querySelector('#profile-form');
        profileForm?.addEventListener('submit', (e) => {
            e.preventDefault();
            nickname = root.querySelector('#nickname').value.trim();
            biography = root.querySelector('#biography').value.trim();
            quote = root.querySelector('#quote').value.trim();
            profileVisibility = root.querySelector('input[name="visibility"]:checked')?.value || 'public';

            localStorage.setItem('efrei_nickname', nickname);
            localStorage.setItem('efrei_biography', biography);
            localStorage.setItem('efrei_quote', quote);
            localStorage.setItem('efrei_profile_visibility', profileVisibility);

            showSaveStatus('Profil enregistre');
            render();
        });

        // Biography character count
        const biographyInput = root.querySelector('#biography');
        biographyInput?.addEventListener('input', () => {
            const small = biographyInput.parentElement.querySelector('small');
            if (small) {
                small.textContent = `${biographyInput.value.length}/500 caracteres`;
            }
        });

        // Auth method selection
        const authMethodInputs = root.querySelectorAll('input[name="auth-method"]');
        authMethodInputs.forEach(input => {
            input.addEventListener('change', () => {
                authMethod = input.value;
                localStorage.setItem('efrei_auth_method', authMethod);
                render();
            });
        });

        // Password form
        const passwordForm = root.querySelector('#password-form');
        passwordForm?.addEventListener('submit', (e) => {
            e.preventDefault();
            const newPassword = root.querySelector('#new-password').value;
            const confirmPassword = root.querySelector('#confirm-password').value;

            if (newPassword !== confirmPassword) {
                showSaveStatus('Les mots de passe ne correspondent pas', 'error');
                return;
            }

            // In real implementation, call API to change password
            showSaveStatus('Mot de passe modifie');
            passwordForm.reset();
        });

        // TOTP setup
        const enableTotpBtn = root.querySelector('#enable-totp');
        enableTotpBtn?.addEventListener('click', () => {
            showTotpSetup = true;
            totpSecret = null;
            render();
        });

        const cancelTotpBtn = root.querySelector('#cancel-totp-setup');
        cancelTotpBtn?.addEventListener('click', () => {
            showTotpSetup = false;
            totpSecret = null;
            render();
        });

        const verifyTotpBtn = root.querySelector('#verify-totp');
        verifyTotpBtn?.addEventListener('click', () => {
            const code = root.querySelector('#totp-code').value;
            if (code.length === 6 && /^\d{6}$/.test(code)) {
                // In real implementation, verify with backend
                totpEnabled = true;
                showTotpSetup = false;
                localStorage.setItem('efrei_totp_enabled', 'true');
                showSaveStatus('2FA activee avec succes');
                render();
            } else {
                showSaveStatus('Code invalide', 'error');
            }
        });

        const disableTotpBtn = root.querySelector('#disable-totp');
        disableTotpBtn?.addEventListener('click', () => {
            if (confirm('Etes-vous sur de vouloir desactiver la 2FA ?')) {
                totpEnabled = false;
                localStorage.setItem('efrei_totp_enabled', 'false');
                showSaveStatus('2FA desactivee');
                render();
            }
        });

        // Passkey registration
        const registerPasskeyBtn = root.querySelector('#register-passkey');
        registerPasskeyBtn?.addEventListener('click', async () => {
            try {
                // Check WebAuthn support
                if (!window.PublicKeyCredential) {
                    showSaveStatus('Votre navigateur ne supporte pas les passkeys', 'error');
                    return;
                }

                // In real implementation, get challenge from backend
                const mockChallenge = new Uint8Array(32);
                crypto.getRandomValues(mockChallenge);

                const credential = await navigator.credentials.create({
                    publicKey: {
                        challenge: mockChallenge,
                        rp: { name: 'Central E', id: window.location.hostname },
                        user: {
                            id: new Uint8Array(16),
                            name: 'user@efrei.fr',
                            displayName: 'Utilisateur'
                        },
                        pubKeyCredParams: [
                            { type: 'public-key', alg: -7 },  // ES256
                            { type: 'public-key', alg: -257 } // RS256
                        ],
                        authenticatorSelection: {
                            authenticatorAttachment: 'platform',
                            userVerification: 'required'
                        },
                        timeout: 60000
                    }
                });

                if (credential) {
                    const name = prompt('Donnez un nom a cette passkey:', 'Ma passkey');
                    passkeysRegistered.push({
                        name: name || 'Passkey',
                        createdAt: new Date().toISOString(),
                        id: credential.id
                    });
                    localStorage.setItem('efrei_passkeys', JSON.stringify(passkeysRegistered));
                    showSaveStatus('Passkey enregistree avec succes');
                    render();
                }
            } catch (error) {
                console.error('Passkey registration error:', error);
                if (error.name === 'NotAllowedError') {
                    showSaveStatus('Enregistrement annule', 'error');
                } else {
                    showSaveStatus('Erreur lors de l\'enregistrement', 'error');
                }
            }
        });

        // Remove passkey
        const removePasskeyBtns = root.querySelectorAll('.remove-passkey');
        removePasskeyBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const index = parseInt(btn.dataset.index);
                if (confirm('Supprimer cette passkey ?')) {
                    passkeysRegistered.splice(index, 1);
                    localStorage.setItem('efrei_passkeys', JSON.stringify(passkeysRegistered));
                    showSaveStatus('Passkey supprimee');
                    render();
                }
            });
        });

        // Logout all sessions
        const logoutAllBtn = root.querySelector('#logout-all');
        logoutAllBtn?.addEventListener('click', () => {
            if (confirm('Deconnecter toutes les sessions ?')) {
                // In real implementation, call API
                state.clearAuth();
                showSaveStatus('Toutes les sessions ont ete deconnectees');
                setTimeout(() => navigate('/login'), 1000);
            }
        });

        // Export data
        const exportDataBtn = root.querySelector('#export-data');
        exportDataBtn?.addEventListener('click', () => {
            const data = {
                theme,
                nickname,
                biography,
                quote,
                profileVisibility,
                exportedAt: new Date().toISOString()
            };
            const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = 'centrale-data-export.json';
            a.click();
            URL.revokeObjectURL(url);
            showSaveStatus('Donnees exportees');
        });

        // Clear local data
        const clearLocalDataBtn = root.querySelector('#clear-local-data');
        clearLocalDataBtn?.addEventListener('click', () => {
            if (confirm('Effacer toutes les donnees locales ? Cela ne supprimera pas votre compte.')) {
                const keys = Object.keys(localStorage).filter(k => k.startsWith('efrei_'));
                keys.forEach(k => localStorage.removeItem(k));
                showSaveStatus('Donnees locales effacees');
                window.location.reload();
            }
        });

        // Delete account
        const deleteAccountBtn = root.querySelector('#delete-account');
        deleteAccountBtn?.addEventListener('click', () => {
            if (confirm('ATTENTION: Cette action est irreversible. Voulez-vous vraiment supprimer votre compte ?')) {
                if (confirm('Derniere confirmation: toutes vos donnees seront perdues. Continuer ?')) {
                    // In real implementation, call API to delete account
                    showSaveStatus('Compte supprime');
                    state.clearAuth();
                    setTimeout(() => navigate('/'), 1000);
                }
            }
        });
    };

    // Initial render
    render();

    // Cleanup
    return () => {
        // Nothing to cleanup
    };
};
