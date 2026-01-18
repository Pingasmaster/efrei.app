// Mock data for dashboard - easily replaceable with real API calls later

// Generate dates relative to today for realistic mock data
const today = new Date();
const formatDate = (date) => date.toISOString().split('T')[0];

// User assignments storage key
const USER_ASSIGNMENTS_KEY = 'efrei_user_assignments';

const addDays = (date, days) => {
    const result = new Date(date);
    result.setDate(result.getDate() + days);
    return result;
};

// Schedule data for multiple days
export const mockSchedule = [
    // Today
    {
        id: "class-1",
        name: "Algorithmique Avancee",
        professor: "Prof. Martin",
        room: "E301",
        building: "E",
        startTime: "09:00",
        endTime: "10:30",
        date: formatDate(today),
        moodleUrl: "https://moodle.efrei.fr/course/view.php?id=1234",
        teamsUrl: "https://teams.microsoft.com/l/team/algo-avancee",
        color: "#00D4FF"
    },
    {
        id: "class-2",
        name: "Base de Donnees",
        professor: "Prof. Dubois",
        room: "E205",
        building: "E",
        startTime: "10:45",
        endTime: "12:15",
        date: formatDate(today),
        moodleUrl: "https://moodle.efrei.fr/course/view.php?id=2345",
        teamsUrl: "https://teams.microsoft.com/l/team/base-donnees",
        color: "#4ade80"
    },
    {
        id: "class-3",
        name: "Anglais Professionnel",
        professor: "Prof. Smith",
        room: "B102",
        building: "B",
        startTime: "14:00",
        endTime: "15:30",
        date: formatDate(today),
        moodleUrl: "https://moodle.efrei.fr/course/view.php?id=3456",
        teamsUrl: "https://teams.microsoft.com/l/team/anglais-pro",
        color: "#fbbf24"
    },
    {
        id: "class-4",
        name: "Projet Informatique",
        professor: "Prof. Bernard",
        room: "E401",
        building: "E",
        startTime: "15:45",
        endTime: "17:15",
        date: formatDate(today),
        moodleUrl: "https://moodle.efrei.fr/course/view.php?id=4567",
        teamsUrl: "https://teams.microsoft.com/l/team/projet-info",
        color: "#f472b6"
    },
    // Tomorrow
    {
        id: "class-5",
        name: "Mathematiques Discretes",
        professor: "Prof. Laurent",
        room: "C201",
        building: "C",
        startTime: "08:30",
        endTime: "10:00",
        date: formatDate(addDays(today, 1)),
        moodleUrl: "https://moodle.efrei.fr/course/view.php?id=5678",
        teamsUrl: "https://teams.microsoft.com/l/team/math-discretes",
        color: "#a78bfa"
    },
    {
        id: "class-6",
        name: "Reseaux Informatiques",
        professor: "Prof. Moreau",
        room: "E102",
        building: "E",
        startTime: "10:15",
        endTime: "11:45",
        date: formatDate(addDays(today, 1)),
        moodleUrl: "https://moodle.efrei.fr/course/view.php?id=6789",
        teamsUrl: "https://teams.microsoft.com/l/team/reseaux",
        color: "#fb923c"
    },
    {
        id: "class-7",
        name: "Gestion de Projet",
        professor: "Prof. Petit",
        room: "B301",
        building: "B",
        startTime: "14:00",
        endTime: "16:00",
        date: formatDate(addDays(today, 1)),
        moodleUrl: "https://moodle.efrei.fr/course/view.php?id=7890",
        teamsUrl: "https://teams.microsoft.com/l/team/gestion-projet",
        color: "#22d3d3"
    },
    // Day after tomorrow
    {
        id: "class-8",
        name: "Intelligence Artificielle",
        professor: "Prof. Chen",
        room: "E501",
        building: "E",
        startTime: "09:00",
        endTime: "12:00",
        date: formatDate(addDays(today, 2)),
        moodleUrl: "https://moodle.efrei.fr/course/view.php?id=8901",
        teamsUrl: "https://teams.microsoft.com/l/team/ia",
        color: "#ef4444"
    },
    {
        id: "class-9",
        name: "Securite Informatique",
        professor: "Prof. Garcia",
        room: "E301",
        building: "E",
        startTime: "14:00",
        endTime: "15:30",
        date: formatDate(addDays(today, 2)),
        moodleUrl: "https://moodle.efrei.fr/course/view.php?id=9012",
        teamsUrl: "https://teams.microsoft.com/l/team/securite",
        color: "#06b6d4"
    }
];

// Assignments from Moodle and Teams
export const mockAssignments = [
    {
        id: "assign-1",
        title: "TP Algorithmes de tri",
        courseId: "class-1",
        courseName: "Algorithmique Avancee",
        source: "moodle",
        dueDate: addDays(today, 1).toISOString(),
        url: "https://moodle.efrei.fr/mod/assign/view.php?id=11111",
        description: "Implementer quicksort et mergesort en Python"
    },
    {
        id: "assign-2",
        title: "Rapport Projet BD",
        courseId: "class-2",
        courseName: "Base de Donnees",
        source: "teams",
        dueDate: addDays(today, 3).toISOString(),
        url: "https://teams.microsoft.com/l/entity/assignment-bd",
        description: "Rendu du rapport de conception de base de donnees"
    },
    {
        id: "assign-3",
        title: "Presentation Orale",
        courseId: "class-3",
        courseName: "Anglais Professionnel",
        source: "moodle",
        dueDate: addDays(today, 5).toISOString(),
        url: "https://moodle.efrei.fr/mod/assign/view.php?id=22222",
        description: "Presentation de 10 minutes sur un sujet professionnel"
    },
    {
        id: "assign-4",
        title: "Sprint Review",
        courseId: "class-4",
        courseName: "Projet Informatique",
        source: "teams",
        dueDate: addDays(today, 7).toISOString(),
        url: "https://teams.microsoft.com/l/entity/sprint-review",
        description: "Demo du sprint 2 et retrospective"
    },
    {
        id: "assign-5",
        title: "Exercices Graphes",
        courseId: "class-5",
        courseName: "Mathematiques Discretes",
        source: "moodle",
        dueDate: addDays(today, 2).toISOString(),
        url: "https://moodle.efrei.fr/mod/assign/view.php?id=33333",
        description: "Serie d'exercices sur les graphes et arbres"
    },
    {
        id: "assign-6",
        title: "Configuration Routeur",
        courseId: "class-6",
        courseName: "Reseaux Informatiques",
        source: "moodle",
        dueDate: addDays(today, 4).toISOString(),
        url: "https://moodle.efrei.fr/mod/assign/view.php?id=44444",
        description: "TP de configuration de routeurs Cisco"
    }
];

// Helper functions
export const getScheduleForDate = (date) => {
    const dateStr = formatDate(date);
    return mockSchedule.filter(item => item.date === dateStr)
        .sort((a, b) => a.startTime.localeCompare(b.startTime));
};

export const getNextClass = (date) => {
    const now = new Date();
    const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    const dateStr = formatDate(date);

    const todayClasses = mockSchedule
        .filter(item => item.date === dateStr)
        .sort((a, b) => a.startTime.localeCompare(b.startTime));

    // If looking at today, find next upcoming class
    if (dateStr === formatDate(now)) {
        const nextClass = todayClasses.find(c => c.endTime > currentTime);
        return nextClass || todayClasses[0];
    }

    // For other days, return first class
    return todayClasses[0];
};

export const getAssignmentsForCourse = (courseId) => {
    const userAssignments = getUserAssignments();
    const allAssignments = [...mockAssignments, ...userAssignments];
    return allAssignments.filter(a => a.courseId === courseId);
};

export const getUpcomingAssignments = (limit = 5) => {
    const now = new Date();
    const userAssignments = getUserAssignments();
    const allAssignments = [...mockAssignments, ...userAssignments];
    return allAssignments
        .filter(a => new Date(a.dueDate) > now)
        .sort((a, b) => new Date(a.dueDate) - new Date(b.dueDate))
        .slice(0, limit);
};

export const getAssignmentsDueForClass = (classId) => {
    const classItem = mockSchedule.find(c => c.id === classId);
    if (!classItem) return [];

    const classDate = new Date(classItem.date);
    const nextDay = addDays(classDate, 1);

    const userAssignments = getUserAssignments();
    const allAssignments = [...mockAssignments, ...userAssignments];

    return allAssignments.filter(a => {
        const dueDate = new Date(a.dueDate);
        return a.courseId === classId && dueDate <= nextDay;
    });
};

// Format date for display in French
export const formatDateFrench = (date) => {
    const days = ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi'];
    const months = ['Janvier', 'Fevrier', 'Mars', 'Avril', 'Mai', 'Juin',
                    'Juillet', 'Aout', 'Septembre', 'Octobre', 'Novembre', 'Decembre'];

    return `${days[date.getDay()]} ${date.getDate()} ${months[date.getMonth()]} ${date.getFullYear()}`;
};

// Format relative date for assignments
export const formatRelativeDate = (dateStr) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffTime = date - now;
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) return "Aujourd'hui";
    if (diffDays === 1) return "Demain";
    if (diffDays < 7) return `Dans ${diffDays} jours`;

    const day = date.getDate();
    const months = ['Jan', 'Fev', 'Mar', 'Avr', 'Mai', 'Juin',
                    'Juil', 'Aout', 'Sep', 'Oct', 'Nov', 'Dec'];
    return `${day} ${months[date.getMonth()]}`;
};

// User assignment management
export const getUserAssignments = () => {
    try {
        const stored = localStorage.getItem(USER_ASSIGNMENTS_KEY);
        return stored ? JSON.parse(stored) : [];
    } catch {
        return [];
    }
};

export const addUserAssignment = (assignment) => {
    const assignments = getUserAssignments();
    const newAssignment = {
        ...assignment,
        id: `user-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        source: 'user',
        createdAt: new Date().toISOString()
    };
    assignments.push(newAssignment);
    localStorage.setItem(USER_ASSIGNMENTS_KEY, JSON.stringify(assignments));
    return newAssignment;
};

export const deleteUserAssignment = (assignmentId) => {
    const assignments = getUserAssignments();
    const filtered = assignments.filter(a => a.id !== assignmentId);
    localStorage.setItem(USER_ASSIGNMENTS_KEY, JSON.stringify(filtered));
};

export const updateUserAssignment = (assignmentId, updates) => {
    const assignments = getUserAssignments();
    const index = assignments.findIndex(a => a.id === assignmentId);
    if (index !== -1) {
        assignments[index] = { ...assignments[index], ...updates };
        localStorage.setItem(USER_ASSIGNMENTS_KEY, JSON.stringify(assignments));
        return assignments[index];
    }
    return null;
};
