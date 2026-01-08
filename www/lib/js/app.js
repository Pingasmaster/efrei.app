class App {
    constructor () {
        // Variables for the page gestion system
        this.currentPage = "Home";
        this.pages = [
            "Home" : new Home(),
            "Login": new Login(),
            "Signup": new Signup(),
            "Profil": new Profil(),
            "Magasin": new Magasin(),
            "Paris": new Paris(),
        ];
        this.titles = [
            "Home": "Accueil",
            "Test1": "Test 1 - Première page de test"
            "Home": "Accueil",
            "Test1": "Test 1 - Première page de test"
            "Test1": "Test 1 - Première page de test"
            "Test1": "Test 1 - Première page de test"
        ];
        // Log init
        this.log = new Log();
        // Service worker registration
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/service-worker.js');
        }
    }

    refresh() {
        // Calls refresh on the page
        this.pages[this.currentPage].refresh();
    }

    changePage(newPageName) {
        if (this.pages[newPageName]) {
            if (!this.currentPage == newPageName) {
                // Close old page
                this.pages[this.currentPage].close();
                //  Update current page
                this.currentPage = newPageName;
                // Open new page
                this.pages[this.currentPage].init();
            } else{
                // Dumbass calls changePage instead of refresh. Unacceptable.
                app.log.write("Error while changing page, same page requested as the current page.", "error");
            }
        } else { app.log.write("Error while changing page, this page does not exist: " + String(newPageName), "error"); }
    }

    exit() {
        // We close the current page and bail out
        this.pages[this.currentPage].close();
        app.log.write("Bye bye, exit() on app.js requested.");
    }
}
