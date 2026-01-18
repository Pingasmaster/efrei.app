// Onboarding steps content
const steps = [
    {
        title: "Bienvenue sur <span>Central E</span>!",
        text: "Je suis la pour te faire decouvrir la plateforme. En quelques etapes, tu sauras tout ce qu'il faut pour bien commencer."
    },
    {
        title: "Ton <span>emploi du temps</span>",
        text: "Retrouve ton prochain cours en un coup d'oeil : salle, batiment, horaires et professeur. Survole pour voir toute ta journee."
    },
    {
        title: "Tes <span>taches</span> reunies",
        text: "Fini de jongler entre Moodle et Teams! Toutes tes taches et devoirs sont regroupes ici, avec leurs echeances."
    },
    {
        title: "C'est parti!",
        text: "Tu es pret a explorer Central E. Clique sur tes cours pour acceder directement a Moodle et Teams. Bonne navigation!"
    }
];

export const renderOnboarding = (container, { state, onComplete }) => {
    let currentStep = 0;

    const render = () => {
        const step = steps[currentStep];
        const isLastStep = currentStep === steps.length - 1;

        container.innerHTML = `
            <div class="onboarding-overlay">
                <div class="onboarding-container">
                    <div class="onboarding-avatar">
                        <div class="avatar-placeholder" id="avatar-container">
                            <div class="avatar-placeholder-text">
                                <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                                    <circle cx="12" cy="7" r="4"/>
                                </svg>
                                <p>Avatar a venir</p>
                            </div>
                        </div>
                    </div>

                    <div class="onboarding-content">
                        <div class="chat-bubble" key="${currentStep}">
                            <h2>${step.title}</h2>
                            <p>${step.text}</p>
                        </div>

                        <div class="onboarding-progress">
                            ${steps.map((_, i) => `
                                <div class="progress-dot ${i === currentStep ? 'active' : ''} ${i < currentStep ? 'completed' : ''}"></div>
                            `).join('')}
                        </div>

                        <div class="onboarding-actions">
                            <button class="skip-btn" id="skip-onboarding">Passer</button>
                            <button class="btn primary" id="next-onboarding">
                                ${isLastStep ? 'Commencer' : 'Suivant'}
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        attachEventListeners();
    };

    const attachEventListeners = () => {
        const skipBtn = container.querySelector('#skip-onboarding');
        const nextBtn = container.querySelector('#next-onboarding');

        skipBtn?.addEventListener('click', completeOnboarding);
        nextBtn?.addEventListener('click', handleNext);

        // Keyboard navigation
        const handleKeydown = (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                handleNext();
            } else if (e.key === 'Escape') {
                completeOnboarding();
            }
        };

        document.addEventListener('keydown', handleKeydown);

        // Store cleanup function
        container._keydownCleanup = () => {
            document.removeEventListener('keydown', handleKeydown);
        };
    };

    const handleNext = () => {
        if (currentStep < steps.length - 1) {
            currentStep++;
            render();
        } else {
            completeOnboarding();
        }
    };

    const completeOnboarding = () => {
        // Cleanup keyboard listener
        if (container._keydownCleanup) {
            container._keydownCleanup();
        }

        // Mark onboarding as completed in state
        state.completeOnboarding();

        // Fade out animation
        const overlay = container.querySelector('.onboarding-overlay');
        if (overlay) {
            overlay.style.animation = 'fade-in 0.3s ease-out reverse';
            setTimeout(() => {
                container.innerHTML = '';
                if (typeof onComplete === 'function') {
                    onComplete();
                }
            }, 300);
        } else {
            container.innerHTML = '';
            if (typeof onComplete === 'function') {
                onComplete();
            }
        }
    };

    // Initial render
    render();

    // Return cleanup function
    return () => {
        if (container._keydownCleanup) {
            container._keydownCleanup();
        }
        container.innerHTML = '';
    };
};

// Helper to show onboarding as an overlay on top of the current page
export const showOnboardingOverlay = (state, onComplete) => {
    // Create overlay container if it doesn't exist
    let overlayContainer = document.getElementById('onboarding-overlay-container');
    if (!overlayContainer) {
        overlayContainer = document.createElement('div');
        overlayContainer.id = 'onboarding-overlay-container';
        document.body.appendChild(overlayContainer);
    }

    return renderOnboarding(overlayContainer, { state, onComplete });
};
