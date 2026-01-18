// AI Chat page with Ollama integration
export const renderChat = (root, { api, state, navigate }) => {
    let messages = [];
    let isLoading = false;
    let currentModel = localStorage.getItem('efrei_ollama_model') || 'llama3.2';
    let ollamaUrl = localStorage.getItem('efrei_ollama_url') || 'http://localhost:11434';
    let availableModels = [];
    let attachedFiles = [];
    let connectionStatus = 'disconnected'; // disconnected, connecting, connected, error
    let showSettings = false;
    let abortController = null;

    const init = async () => {
        render();
        await checkConnection();
    };

    const checkConnection = async () => {
        connectionStatus = 'connecting';
        render();

        try {
            const response = await fetch(`${ollamaUrl}/api/tags`, {
                method: 'GET',
                signal: AbortSignal.timeout(5000)
            });

            if (response.ok) {
                const data = await response.json();
                availableModels = data.models || [];
                connectionStatus = 'connected';

                // If current model not in list, select first available
                if (availableModels.length > 0 && !availableModels.find(m => m.name === currentModel)) {
                    currentModel = availableModels[0].name;
                    localStorage.setItem('efrei_ollama_model', currentModel);
                }
            } else {
                connectionStatus = 'error';
            }
        } catch (error) {
            connectionStatus = 'error';
            availableModels = [];
        }

        render();
    };

    const render = () => {
        root.innerHTML = `
            <div class="chat-container">
                <div class="chat-sidebar glass-card">
                    <div class="chat-sidebar-header">
                        <h2>Conversations</h2>
                        <button class="new-chat-btn" id="new-chat">
                            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="12" y1="5" x2="12" y2="19"/>
                                <line x1="5" y1="12" x2="19" y2="12"/>
                            </svg>
                            Nouvelle
                        </button>
                    </div>
                    <div class="chat-history" id="chat-history">
                        ${renderConversationHistory()}
                    </div>
                    <div class="chat-sidebar-footer">
                        <button class="settings-btn" id="toggle-settings">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="3"/>
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                            </svg>
                            Parametres Ollama
                        </button>
                    </div>
                </div>

                <div class="chat-main">
                    <div class="chat-header glass-card">
                        <div class="chat-header-info">
                            <div class="ai-avatar">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/>
                                    <circle cx="7.5" cy="14.5" r="1.5"/>
                                    <circle cx="16.5" cy="14.5" r="1.5"/>
                                </svg>
                            </div>
                            <div class="chat-header-text">
                                <h1>Assistant IA</h1>
                                <div class="model-selector">
                                    <select id="model-select" ${connectionStatus !== 'connected' ? 'disabled' : ''}>
                                        ${availableModels.length > 0
                                            ? availableModels.map(m => `<option value="${m.name}" ${m.name === currentModel ? 'selected' : ''}>${m.name}</option>`).join('')
                                            : `<option value="${currentModel}">${currentModel}</option>`
                                        }
                                    </select>
                                    <span class="connection-status ${connectionStatus}">
                                        ${connectionStatus === 'connected' ? 'Connecte' :
                                          connectionStatus === 'connecting' ? 'Connexion...' :
                                          connectionStatus === 'error' ? 'Deconnecte' : 'Hors ligne'}
                                    </span>
                                </div>
                            </div>
                        </div>
                        <div class="chat-header-actions">
                            ${isLoading ? `
                                <button class="chat-action-btn stop-btn" id="stop-generation" title="Arreter la generation">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <rect x="6" y="6" width="12" height="12"/>
                                    </svg>
                                </button>
                            ` : ''}
                            <button class="chat-action-btn" id="clear-chat" title="Effacer la conversation">
                                <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="3 6 5 6 21 6"/>
                                    <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                                </svg>
                            </button>
                        </div>
                    </div>

                    ${showSettings ? renderSettingsPanel() : ''}

                    <div class="chat-messages" id="chat-messages">
                        ${messages.length === 0 ? renderWelcome() : messages.map(renderMessage).join('')}
                        ${isLoading ? renderTypingIndicator() : ''}
                    </div>

                    <div class="chat-input-container glass-card">
                        ${attachedFiles.length > 0 ? renderAttachedFiles() : ''}
                        <form id="chat-form" class="chat-form">
                            <div class="chat-input-wrapper">
                                <button type="button" class="attach-btn" id="attach-file" title="Joindre un fichier">
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M21.44 11.05l-9.19 9.19a6 6 0 0 1-8.49-8.49l9.19-9.19a4 4 0 0 1 5.66 5.66l-9.2 9.19a2 2 0 0 1-2.83-2.83l8.49-8.48"/>
                                    </svg>
                                </button>
                                <input type="file" id="file-input" multiple accept=".txt,.md,.js,.py,.json,.csv,.html,.css,.ts,.jsx,.tsx,.c,.cpp,.h,.java,.go,.rs,.sql" hidden>
                                <textarea
                                    id="chat-input"
                                    placeholder="${connectionStatus === 'connected' ? 'Posez votre question...' : 'Configurez Ollama dans les parametres...'}"
                                    rows="1"
                                    ${isLoading || connectionStatus !== 'connected' ? 'disabled' : ''}
                                ></textarea>
                                <button type="submit" class="send-btn" ${isLoading || connectionStatus !== 'connected' ? 'disabled' : ''}>
                                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <line x1="22" y1="2" x2="11" y2="13"/>
                                        <polygon points="22 2 15 22 11 13 2 9 22 2"/>
                                    </svg>
                                </button>
                            </div>
                            <div class="chat-input-info">
                                <span>${attachedFiles.length > 0 ? `${attachedFiles.length} fichier(s) joint(s)` : 'Shift+Entree pour nouvelle ligne'}</span>
                                <span class="char-count">0/4000</span>
                            </div>
                        </form>
                    </div>
                </div>
            </div>
        `;

        attachEventListeners();
    };

    const renderSettingsPanel = () => {
        return `
            <div class="settings-panel glass-card">
                <div class="settings-header">
                    <h3>Configuration Ollama</h3>
                    <button class="close-settings" id="close-settings">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="18" y1="6" x2="6" y2="18"/>
                            <line x1="6" y1="6" x2="18" y2="18"/>
                        </svg>
                    </button>
                </div>
                <div class="settings-content">
                    <label class="field">
                        <span>URL du serveur Ollama</span>
                        <input type="url" id="ollama-url" value="${ollamaUrl}" placeholder="http://localhost:11434">
                    </label>
                    <div class="settings-info">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"/>
                            <line x1="12" y1="16" x2="12" y2="12"/>
                            <line x1="12" y1="8" x2="12.01" y2="8"/>
                        </svg>
                        <p>Assurez-vous qu'Ollama est installe et en cours d'execution sur votre machine. Telechargez-le sur <a href="https://ollama.ai" target="_blank" rel="noopener">ollama.ai</a></p>
                    </div>
                    <div class="settings-actions">
                        <button class="btn ghost" id="test-connection">Tester la connexion</button>
                        <button class="btn primary" id="save-settings">Enregistrer</button>
                    </div>
                </div>
            </div>
        `;
    };

    const renderConversationHistory = () => {
        // For now, show empty state - could be expanded to save conversations
        return `
            <div class="chat-history-empty">
                <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
                </svg>
                <p>Les conversations ne sont pas sauvegardees</p>
            </div>
        `;
    };

    const renderWelcome = () => {
        return `
            <div class="chat-welcome">
                <div class="welcome-icon">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/>
                        <circle cx="7.5" cy="14.5" r="1.5"/>
                        <circle cx="16.5" cy="14.5" r="1.5"/>
                    </svg>
                </div>
                <h2>Assistant IA avec Ollama</h2>
                <p>Discutez avec des modeles IA en local. Joignez des fichiers pour fournir du contexte a vos questions.</p>

                ${connectionStatus !== 'connected' ? `
                    <div class="connection-warning">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                            <line x1="12" y1="9" x2="12" y2="13"/>
                            <line x1="12" y1="17" x2="12.01" y2="17"/>
                        </svg>
                        <div>
                            <strong>Ollama non connecte</strong>
                            <p>Verifiez que le serveur est en cours d'execution ou modifiez l'URL dans les parametres.</p>
                        </div>
                    </div>
                ` : `
                    <div class="welcome-suggestions">
                        <h3>Suggestions pour commencer</h3>
                        <div class="suggestion-grid">
                            <button class="suggestion-btn" data-suggestion="Explique-moi les bases de l'algorithmique">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                    <polyline points="14 2 14 8 20 8"/>
                                </svg>
                                Explique-moi les bases de l'algorithmique
                            </button>
                            <button class="suggestion-btn" data-suggestion="Aide-moi a debugger ce code">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M8 3H5a2 2 0 0 0-2 2v14c0 1.1.9 2 2 2h3"/>
                                    <path d="M16 3h3a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-3"/>
                                    <line x1="12" y1="20" x2="12" y2="4"/>
                                    <path d="M9 10l3 3 3-3"/>
                                </svg>
                                Aide-moi a debugger ce code
                            </button>
                            <button class="suggestion-btn" data-suggestion="Resume ce document pour moi">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                    <line x1="16" y1="13" x2="8" y2="13"/>
                                    <line x1="16" y1="17" x2="8" y2="17"/>
                                </svg>
                                Resume ce document pour moi
                            </button>
                            <button class="suggestion-btn" data-suggestion="Ecris une fonction qui...">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <polyline points="16 18 22 12 16 6"/>
                                    <polyline points="8 6 2 12 8 18"/>
                                </svg>
                                Ecris une fonction qui...
                            </button>
                        </div>
                    </div>
                `}
            </div>
        `;
    };

    const renderMessage = (message) => {
        const isUser = message.role === 'user';
        return `
            <div class="chat-message ${isUser ? 'user' : 'assistant'}">
                <div class="message-avatar">
                    ${isUser ? `
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                            <circle cx="12" cy="7" r="4"/>
                        </svg>
                    ` : `
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/>
                            <circle cx="7.5" cy="14.5" r="1.5"/>
                            <circle cx="16.5" cy="14.5" r="1.5"/>
                        </svg>
                    `}
                </div>
                <div class="message-content">
                    ${message.files && message.files.length > 0 ? `
                        <div class="message-files">
                            ${message.files.map(f => `
                                <span class="file-badge">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                                        <polyline points="14 2 14 8 20 8"/>
                                    </svg>
                                    ${f.name}
                                </span>
                            `).join('')}
                        </div>
                    ` : ''}
                    <div class="message-text">${formatMessageContent(message.content)}</div>
                    <div class="message-time">${formatTime(message.timestamp)}</div>
                </div>
            </div>
        `;
    };

    const renderTypingIndicator = () => {
        return `
            <div class="chat-message assistant typing">
                <div class="message-avatar">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 2a2 2 0 0 1 2 2c0 .74-.4 1.39-1 1.73V7h1a7 7 0 0 1 7 7h1a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1h-1v1a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-1H2a1 1 0 0 1-1-1v-3a1 1 0 0 1 1-1h1a7 7 0 0 1 7-7h1V5.73c-.6-.34-1-.99-1-1.73a2 2 0 0 1 2-2z"/>
                        <circle cx="7.5" cy="14.5" r="1.5"/>
                        <circle cx="16.5" cy="14.5" r="1.5"/>
                    </svg>
                </div>
                <div class="message-content">
                    <div class="typing-indicator">
                        <span></span>
                        <span></span>
                        <span></span>
                    </div>
                </div>
            </div>
        `;
    };

    const renderAttachedFiles = () => {
        return `
            <div class="attached-files">
                ${attachedFiles.map((file, index) => `
                    <div class="attached-file">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                            <polyline points="14 2 14 8 20 8"/>
                        </svg>
                        <span class="file-name">${file.name}</span>
                        <span class="file-size">${formatFileSize(file.size)}</span>
                        <button class="remove-file" data-index="${index}">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"/>
                                <line x1="6" y1="6" x2="18" y2="18"/>
                            </svg>
                        </button>
                    </div>
                `).join('')}
            </div>
        `;
    };

    const formatMessageContent = (content) => {
        // Basic markdown-like formatting
        let formatted = escapeHtml(content);

        // Code blocks
        formatted = formatted.replace(/```(\w*)\n?([\s\S]*?)```/g, '<pre><code class="language-$1">$2</code></pre>');

        // Inline code
        formatted = formatted.replace(/`([^`]+)`/g, '<code>$1</code>');

        // Bold
        formatted = formatted.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

        // Italic
        formatted = formatted.replace(/\*([^*]+)\*/g, '<em>$1</em>');

        // Line breaks
        formatted = formatted.replace(/\n/g, '<br>');

        return formatted;
    };

    const escapeHtml = (text) => {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    };

    const formatTime = (timestamp) => {
        const date = new Date(timestamp);
        return date.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
    };

    const formatFileSize = (bytes) => {
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
    };

    const attachEventListeners = () => {
        const form = root.querySelector('#chat-form');
        const input = root.querySelector('#chat-input');
        const charCount = root.querySelector('.char-count');
        const newChatBtn = root.querySelector('#new-chat');
        const clearChatBtn = root.querySelector('#clear-chat');
        const stopBtn = root.querySelector('#stop-generation');
        const suggestionBtns = root.querySelectorAll('.suggestion-btn');
        const modelSelect = root.querySelector('#model-select');
        const attachBtn = root.querySelector('#attach-file');
        const fileInput = root.querySelector('#file-input');
        const settingsBtn = root.querySelector('#toggle-settings');
        const closeSettingsBtn = root.querySelector('#close-settings');
        const saveSettingsBtn = root.querySelector('#save-settings');
        const testConnectionBtn = root.querySelector('#test-connection');
        const removeFileBtns = root.querySelectorAll('.remove-file');

        // Auto-resize textarea
        input?.addEventListener('input', () => {
            input.style.height = 'auto';
            input.style.height = Math.min(input.scrollHeight, 150) + 'px';
            charCount.textContent = `${input.value.length}/4000`;
        });

        // Handle Enter key (without Shift)
        input?.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                form.dispatchEvent(new Event('submit'));
            }
        });

        // Handle form submission
        form?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const content = input.value.trim();
            if (!content || isLoading || connectionStatus !== 'connected') return;

            await sendMessage(content);
        });

        // Model selection
        modelSelect?.addEventListener('change', (e) => {
            currentModel = e.target.value;
            localStorage.setItem('efrei_ollama_model', currentModel);
        });

        // New chat
        newChatBtn?.addEventListener('click', () => {
            messages = [];
            attachedFiles = [];
            render();
        });

        // Clear chat
        clearChatBtn?.addEventListener('click', () => {
            if (messages.length > 0) {
                messages = [];
                attachedFiles = [];
                render();
            }
        });

        // Stop generation
        stopBtn?.addEventListener('click', () => {
            if (abortController) {
                abortController.abort();
                abortController = null;
                isLoading = false;
                render();
            }
        });

        // Suggestion buttons
        suggestionBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const suggestion = btn.dataset.suggestion;
                if (suggestion && input) {
                    input.value = suggestion;
                    input.dispatchEvent(new Event('input'));
                    input.focus();
                }
            });
        });

        // File attachment
        attachBtn?.addEventListener('click', () => {
            fileInput?.click();
        });

        fileInput?.addEventListener('change', async (e) => {
            const files = Array.from(e.target.files || []);
            for (const file of files) {
                if (file.size > 1024 * 1024) { // 1MB limit
                    alert(`Le fichier ${file.name} est trop volumineux (max 1MB)`);
                    continue;
                }
                try {
                    const content = await readFileContent(file);
                    attachedFiles.push({ name: file.name, size: file.size, content });
                } catch (err) {
                    console.error('Error reading file:', err);
                }
            }
            fileInput.value = '';
            render();
        });

        // Remove attached files
        removeFileBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const index = parseInt(btn.dataset.index);
                attachedFiles.splice(index, 1);
                render();
            });
        });

        // Settings
        settingsBtn?.addEventListener('click', () => {
            showSettings = !showSettings;
            render();
        });

        closeSettingsBtn?.addEventListener('click', () => {
            showSettings = false;
            render();
        });

        saveSettingsBtn?.addEventListener('click', () => {
            const urlInput = root.querySelector('#ollama-url');
            if (urlInput) {
                ollamaUrl = urlInput.value.trim() || 'http://localhost:11434';
                localStorage.setItem('efrei_ollama_url', ollamaUrl);
                showSettings = false;
                checkConnection();
            }
        });

        testConnectionBtn?.addEventListener('click', () => {
            const urlInput = root.querySelector('#ollama-url');
            if (urlInput) {
                ollamaUrl = urlInput.value.trim() || 'http://localhost:11434';
                checkConnection();
            }
        });
    };

    const readFileContent = (file) => {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsText(file);
        });
    };

    const sendMessage = async (content) => {
        // Build context from attached files
        let contextPrompt = '';
        if (attachedFiles.length > 0) {
            contextPrompt = 'Voici le contenu des fichiers joints pour contexte:\n\n';
            for (const file of attachedFiles) {
                contextPrompt += `--- ${file.name} ---\n${file.content}\n\n`;
            }
            contextPrompt += '---\n\nMaintenant, voici ma question:\n';
        }

        const fullContent = contextPrompt + content;

        // Add user message
        messages.push({
            role: 'user',
            content,
            files: attachedFiles.map(f => ({ name: f.name })),
            timestamp: new Date().toISOString()
        });

        const inputEl = root.querySelector('#chat-input');
        const charCount = root.querySelector('.char-count');
        if (inputEl) {
            inputEl.value = '';
            inputEl.style.height = 'auto';
        }
        if (charCount) charCount.textContent = '0/4000';

        // Clear attached files after sending
        const sentFiles = [...attachedFiles];
        attachedFiles = [];

        isLoading = true;
        render();
        scrollToBottom();

        // Build conversation history for context
        const conversationMessages = messages.map(m => ({
            role: m.role,
            content: m.content
        }));

        // Replace last user message with full content including file context
        if (conversationMessages.length > 0) {
            conversationMessages[conversationMessages.length - 1].content = fullContent;
        }

        try {
            abortController = new AbortController();

            const response = await fetch(`${ollamaUrl}/api/chat`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    model: currentModel,
                    messages: conversationMessages,
                    stream: true
                }),
                signal: abortController.signal
            });

            if (!response.ok) {
                throw new Error(`HTTP ${response.status}`);
            }

            const reader = response.body.getReader();
            const decoder = new TextDecoder();
            let assistantMessage = '';

            while (true) {
                const { done, value } = await reader.read();
                if (done) break;

                const chunk = decoder.decode(value);
                const lines = chunk.split('\n').filter(line => line.trim());

                for (const line of lines) {
                    try {
                        const json = JSON.parse(line);
                        if (json.message?.content) {
                            assistantMessage += json.message.content;
                            // Update the last message or add new one
                            const lastMsg = messages[messages.length - 1];
                            if (lastMsg?.role === 'assistant' && lastMsg._streaming) {
                                lastMsg.content = assistantMessage;
                            } else {
                                messages.push({
                                    role: 'assistant',
                                    content: assistantMessage,
                                    timestamp: new Date().toISOString(),
                                    _streaming: true
                                });
                            }
                            render();
                            scrollToBottom();
                        }
                    } catch (e) {
                        // Ignore parsing errors for incomplete chunks
                    }
                }
            }

            // Mark message as complete
            const lastMsg = messages[messages.length - 1];
            if (lastMsg?._streaming) {
                delete lastMsg._streaming;
            }

        } catch (error) {
            if (error.name === 'AbortError') {
                // User cancelled - add partial message note
                const lastMsg = messages[messages.length - 1];
                if (lastMsg?.role === 'assistant') {
                    lastMsg.content += '\n\n[Generation arretee]';
                }
            } else {
                console.error('Ollama error:', error);
                messages.push({
                    role: 'assistant',
                    content: `Erreur de communication avec Ollama: ${error.message}. Verifiez que le serveur est en cours d'execution.`,
                    timestamp: new Date().toISOString()
                });
            }
        } finally {
            isLoading = false;
            abortController = null;
            render();
            scrollToBottom();
        }
    };

    const scrollToBottom = () => {
        const messagesContainer = root.querySelector('#chat-messages');
        if (messagesContainer) {
            messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
    };

    // Initial setup
    init();

    // Cleanup
    return () => {
        if (abortController) {
            abortController.abort();
        }
    };
};
