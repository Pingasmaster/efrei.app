import {
    getScheduleForDate,
    getNextClass,
    getUpcomingAssignments,
    getAssignmentsForCourse,
    getAssignmentsDueForClass,
    formatDateFrench,
    formatRelativeDate,
    mockSchedule,
    addUserAssignment,
    getUserAssignments,
    deleteUserAssignment
} from "../data/mock-data.js";

export const renderDashboard = (root, { api, state, navigate }) => {
    let currentDate = state.selectedDate;
    let expandedCourseId = null;
    let showAllAssignments = false;
    let showAddAssignmentModal = false;

    const render = () => {
        const schedule = getScheduleForDate(currentDate);
        const nextClass = getNextClass(currentDate);
        const assignments = getUpcomingAssignments(showAllAssignments ? 20 : 5);
        const nextClassAssignments = nextClass ? getAssignmentsDueForClass(nextClass.id) : [];

        root.innerHTML = `
            <div class="dashboard-container">
                <div class="dashboard-header">
                    <button class="date-nav-btn prev" aria-label="Jour precedent">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M15 18l-6-6 6-6"/>
                        </svg>
                    </button>
                    <h1 class="current-date">${formatDateFrench(currentDate)}</h1>
                    <button class="date-nav-btn next" aria-label="Jour suivant">
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M9 18l6-6-6-6"/>
                        </svg>
                    </button>
                </div>

                <div class="dashboard-content">
                    <div class="dashboard-main">
                        ${nextClass ? renderNextClass(nextClass, nextClassAssignments, schedule) : renderNoClass()}
                    </div>

                    <div class="dashboard-sidebar">
                        <div class="assignments-panel glass-card ${showAllAssignments ? 'expanded' : ''}">
                            <div class="assignments-header">
                                <h2>Prochaines Taches</h2>
                                <span class="assignments-count">${assignments.length}</span>
                            </div>
                            <div class="assignments-list">
                                ${assignments.length > 0
                                    ? assignments.map(a => renderAssignment(a)).join('')
                                    : '<p class="no-assignments">Aucune tache a venir</p>'
                                }
                            </div>
                            ${!showAllAssignments && assignments.length >= 5 ? `
                                <button class="expand-assignments-btn">
                                    Voir toutes les taches
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M7 17L17 7M17 7H7M17 7V17"/>
                                    </svg>
                                </button>
                            ` : ''}
                            ${showAllAssignments ? `
                                <div class="assignments-panel-actions">
                                    <button class="add-assignment-btn">
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M12 5v14M5 12h14"/>
                                        </svg>
                                        Ajouter une tache
                                    </button>
                                    <button class="collapse-assignments-btn">
                                        Reduire
                                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                            <path d="M17 7L7 17M7 17H17M7 17V7"/>
                                        </svg>
                                    </button>
                                </div>
                            ` : ''}
                        </div>
                    </div>
                </div>
            </div>
            ${showAddAssignmentModal ? renderAddAssignmentModal() : ''}
        `;

        attachEventListeners();
    };

    const renderNextClass = (classItem, dueAssignments, allClasses) => {
        const courseAssignments = getAssignmentsForCourse(classItem.id);
        const isExpanded = expandedCourseId === classItem.id;

        return `
            <div class="next-class-wrapper">
                <div class="next-class-card glass-card ${isExpanded ? 'expanded' : ''}" data-class-id="${classItem.id}">
                    <div class="next-class-badge">Prochain Cours</div>
                    <div class="next-class-main">
                        <h2 class="next-class-name">${classItem.name}</h2>
                        <p class="next-class-professor">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/>
                                <circle cx="12" cy="7" r="4"/>
                            </svg>
                            ${classItem.professor}
                        </p>
                        <div class="next-class-details">
                            <div class="detail-item">
                                <span class="detail-label">Salle</span>
                                <span class="detail-value">${classItem.room}</span>
                            </div>
                            <div class="detail-item">
                                <span class="detail-label">Batiment</span>
                                <span class="detail-value">${classItem.building}</span>
                            </div>
                            <div class="detail-item">
                                <span class="detail-label">Horaires</span>
                                <span class="detail-value">${classItem.startTime} - ${classItem.endTime}</span>
                            </div>
                        </div>

                        ${dueAssignments.length > 0 ? `
                            <div class="class-assignment-alert">
                                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                                    <line x1="12" y1="9" x2="12" y2="13"/>
                                    <line x1="12" y1="17" x2="12.01" y2="17"/>
                                </svg>
                                <span>${dueAssignments.length} devoir${dueAssignments.length > 1 ? 's' : ''} a rendre</span>
                            </div>
                        ` : ''}
                    </div>

                    <div class="next-class-expand-hint">
                        <span>Cliquer pour ${isExpanded ? 'reduire' : 'voir les details'}</span>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" class="${isExpanded ? 'rotated' : ''}">
                            <path d="M6 9l6 6 6-6"/>
                        </svg>
                    </div>

                    ${isExpanded ? `
                        <div class="next-class-expanded">
                            <div class="class-links">
                                <a href="${classItem.moodleUrl}" target="_blank" rel="noopener" class="class-link moodle">
                                    <span class="link-icon">M</span>
                                    <span>Ouvrir Moodle</span>
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                                        <polyline points="15 3 21 3 21 9"/>
                                        <line x1="10" y1="14" x2="21" y2="3"/>
                                    </svg>
                                </a>
                                <a href="${classItem.teamsUrl}" target="_blank" rel="noopener" class="class-link teams">
                                    <span class="link-icon">T</span>
                                    <span>Ouvrir Teams</span>
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
                                        <polyline points="15 3 21 3 21 9"/>
                                        <line x1="10" y1="14" x2="21" y2="3"/>
                                    </svg>
                                </a>
                            </div>

                            ${courseAssignments.length > 0 ? `
                                <div class="class-assignments">
                                    <h4>Taches pour ce cours</h4>
                                    ${courseAssignments.map(a => `
                                        <a href="${a.url}" target="_blank" rel="noopener" class="class-assignment-item">
                                            <span class="source-badge ${a.source}">${a.source === 'moodle' ? 'M' : 'T'}</span>
                                            <span class="assignment-title">${a.title}</span>
                                            <span class="assignment-due">${formatRelativeDate(a.dueDate)}</span>
                                        </a>
                                    `).join('')}
                                </div>
                            ` : ''}
                        </div>
                    ` : ''}
                </div>

                <div class="schedule-expansion">
                    <div class="schedule-header">
                        <h3>Emploi du temps</h3>
                        <span class="class-count">${allClasses.length} cours</span>
                    </div>
                    <div class="schedule-list">
                        ${allClasses.map(c => renderScheduleItem(c, c.id === classItem.id)).join('')}
                    </div>
                </div>
            </div>
        `;
    };

    const renderScheduleItem = (classItem, isNext) => {
        const isExpanded = expandedCourseId === classItem.id;

        return `
            <div class="schedule-item ${isNext ? 'is-next' : ''} ${isExpanded ? 'expanded' : ''}" data-class-id="${classItem.id}">
                <div class="schedule-item-time">
                    <span class="time-start">${classItem.startTime}</span>
                    <span class="time-end">${classItem.endTime}</span>
                </div>
                <div class="schedule-item-color" style="background-color: ${classItem.color}"></div>
                <div class="schedule-item-info">
                    <span class="schedule-item-name">${classItem.name}</span>
                    <span class="schedule-item-location">${classItem.room} - Bat. ${classItem.building}</span>
                </div>
                ${isNext ? '<span class="next-badge">Prochain</span>' : ''}
            </div>
        `;
    };

    const renderNoClass = () => {
        return `
            <div class="no-class-card glass-card">
                <div class="no-class-icon">
                    <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                        <circle cx="12" cy="12" r="10"/>
                        <path d="M8 14s1.5 2 4 2 4-2 4-2"/>
                        <line x1="9" y1="9" x2="9.01" y2="9"/>
                        <line x1="15" y1="9" x2="15.01" y2="9"/>
                    </svg>
                </div>
                <h2>Pas de cours</h2>
                <p>Aucun cours prevu pour cette journee. Profitez-en!</p>
            </div>
        `;
    };

    const renderAssignment = (assignment) => {
        const isUserCreated = assignment.source === 'user';
        return `
            <div class="assignment-item ${isUserCreated ? 'user-created' : ''}" data-assignment-id="${assignment.id}">
                ${assignment.url ? `<a href="${assignment.url}" target="_blank" rel="noopener" class="assignment-link">` : '<div class="assignment-link">'}
                    <div class="assignment-source ${assignment.source}">
                        ${assignment.source === 'moodle' ? 'M' : assignment.source === 'teams' ? 'T' : 'U'}
                    </div>
                    <div class="assignment-content">
                        <span class="assignment-title">${assignment.title}</span>
                        <span class="assignment-course">${assignment.courseName}</span>
                    </div>
                    <div class="assignment-due">
                        <span class="due-label">Echeance</span>
                        <span class="due-date">${formatRelativeDate(assignment.dueDate)}</span>
                    </div>
                ${assignment.url ? '</a>' : '</div>'}
                ${isUserCreated ? `
                    <button class="delete-assignment-btn" data-assignment-id="${assignment.id}" title="Supprimer">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M3 6h18M19 6v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/>
                        </svg>
                    </button>
                ` : ''}
            </div>
        `;
    };

    const renderAddAssignmentModal = () => {
        // Get unique courses for the dropdown
        const courses = [...new Map(mockSchedule.map(c => [c.id, { id: c.id, name: c.name }])).values()];

        return `
            <div class="modal-overlay" id="add-assignment-modal">
                <div class="modal-content glass-card">
                    <div class="modal-header">
                        <h3>Ajouter une tache</h3>
                        <button class="modal-close-btn" aria-label="Fermer">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M18 6L6 18M6 6l12 12"/>
                            </svg>
                        </button>
                    </div>
                    <form id="add-assignment-form" class="assignment-form">
                        <div class="form-group">
                            <label for="assignment-title">Titre *</label>
                            <input type="text" id="assignment-title" name="title" required
                                   placeholder="Ex: Rapport de projet" autocomplete="off">
                        </div>
                        <div class="form-group">
                            <label for="assignment-course">Cours *</label>
                            <select id="assignment-course" name="courseId" required>
                                <option value="">Selectionner un cours</option>
                                ${courses.map(c => `<option value="${c.id}">${c.name}</option>`).join('')}
                                <option value="other">Autre (personnel)</option>
                            </select>
                        </div>
                        <div class="form-group" id="custom-course-group" style="display: none;">
                            <label for="custom-course-name">Nom du cours</label>
                            <input type="text" id="custom-course-name" name="customCourseName"
                                   placeholder="Ex: Tache personnelle">
                        </div>
                        <div class="form-group">
                            <label for="assignment-due">Date d'echeance *</label>
                            <input type="datetime-local" id="assignment-due" name="dueDate" required>
                        </div>
                        <div class="form-group">
                            <label for="assignment-description">Description</label>
                            <textarea id="assignment-description" name="description" rows="3"
                                      placeholder="Description de la tache..."></textarea>
                        </div>
                        <div class="form-group">
                            <label for="assignment-url">Lien (optionnel)</label>
                            <input type="url" id="assignment-url" name="url"
                                   placeholder="https://...">
                        </div>
                        <div class="form-actions">
                            <button type="button" class="btn-secondary cancel-modal-btn">Annuler</button>
                            <button type="submit" class="btn-primary">Ajouter</button>
                        </div>
                    </form>
                </div>
            </div>
        `;
    };

    const attachEventListeners = () => {
        // Date navigation
        const prevBtn = root.querySelector('.date-nav-btn.prev');
        const nextBtn = root.querySelector('.date-nav-btn.next');

        prevBtn?.addEventListener('click', () => {
            currentDate = new Date(currentDate);
            currentDate.setDate(currentDate.getDate() - 1);
            state.setSelectedDate(currentDate);
            render();
        });

        nextBtn?.addEventListener('click', () => {
            currentDate = new Date(currentDate);
            currentDate.setDate(currentDate.getDate() + 1);
            state.setSelectedDate(currentDate);
            render();
        });

        // Next class card click
        const nextClassCard = root.querySelector('.next-class-card');
        nextClassCard?.addEventListener('click', (e) => {
            if (e.target.closest('a')) return; // Don't toggle when clicking links
            const classId = nextClassCard.dataset.classId;
            expandedCourseId = expandedCourseId === classId ? null : classId;
            render();
        });

        // Schedule item clicks
        const scheduleItems = root.querySelectorAll('.schedule-item');
        scheduleItems.forEach(item => {
            item.addEventListener('click', () => {
                const classId = item.dataset.classId;
                expandedCourseId = expandedCourseId === classId ? null : classId;
                render();
            });
        });

        // Expand/collapse assignments
        const expandBtn = root.querySelector('.expand-assignments-btn');
        const collapseBtn = root.querySelector('.collapse-assignments-btn');

        expandBtn?.addEventListener('click', () => {
            showAllAssignments = true;
            render();
        });

        collapseBtn?.addEventListener('click', () => {
            showAllAssignments = false;
            render();
        });

        // Add assignment button
        const addAssignmentBtn = root.querySelector('.add-assignment-btn');
        addAssignmentBtn?.addEventListener('click', () => {
            showAddAssignmentModal = true;
            render();
        });

        // Modal handling
        const modal = root.querySelector('#add-assignment-modal');
        const modalCloseBtn = root.querySelector('.modal-close-btn');
        const cancelBtn = root.querySelector('.cancel-modal-btn');
        const assignmentForm = root.querySelector('#add-assignment-form');
        const courseSelect = root.querySelector('#assignment-course');
        const customCourseGroup = root.querySelector('#custom-course-group');

        const closeModal = () => {
            showAddAssignmentModal = false;
            render();
        };

        modal?.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });

        modalCloseBtn?.addEventListener('click', closeModal);
        cancelBtn?.addEventListener('click', closeModal);

        // Show/hide custom course name field
        courseSelect?.addEventListener('change', (e) => {
            if (customCourseGroup) {
                customCourseGroup.style.display = e.target.value === 'other' ? 'block' : 'none';
            }
        });

        // Handle form submission
        assignmentForm?.addEventListener('submit', async (e) => {
            e.preventDefault();
            const formData = new FormData(assignmentForm);

            const courseId = formData.get('courseId');
            let courseName = '';

            if (courseId === 'other') {
                courseName = formData.get('customCourseName') || 'Personnel';
            } else {
                const course = mockSchedule.find(c => c.id === courseId);
                courseName = course ? course.name : 'Inconnu';
            }

            const newAssignment = {
                title: formData.get('title'),
                courseId: courseId === 'other' ? null : courseId,
                courseName: courseName,
                dueDate: new Date(formData.get('dueDate')).toISOString(),
                description: formData.get('description') || '',
                url: formData.get('url') || null
            };

            // Add to local storage via mock-data
            addUserAssignment(newAssignment);

            // Also try to sync with backend if authenticated
            if (state.token) {
                try {
                    await api.request('/me/assignments', {
                        method: 'POST',
                        body: JSON.stringify(newAssignment)
                    });
                } catch (err) {
                    console.warn('Failed to sync assignment to server:', err);
                }
            }

            showAddAssignmentModal = false;
            render();
        });

        // Delete user assignment buttons
        const deleteButtons = root.querySelectorAll('.delete-assignment-btn');
        deleteButtons.forEach(btn => {
            btn.addEventListener('click', async (e) => {
                e.preventDefault();
                e.stopPropagation();
                const assignmentId = btn.dataset.assignmentId;

                if (confirm('Supprimer cette tache ?')) {
                    deleteUserAssignment(assignmentId);

                    // Also try to sync with backend if authenticated
                    if (state.token) {
                        try {
                            await api.request(`/me/assignments/${assignmentId}`, {
                                method: 'DELETE'
                            });
                        } catch (err) {
                            console.warn('Failed to delete assignment from server:', err);
                        }
                    }

                    render();
                }
            });
        });
    };

    // Initial render
    render();

    // Subscribe to state changes
    const unsubscribe = state.subscribe((snapshot) => {
        if (snapshot.selectedDate !== currentDate) {
            currentDate = snapshot.selectedDate;
            render();
        }
    });

    // Cleanup
    return () => {
        unsubscribe();
    };
};
