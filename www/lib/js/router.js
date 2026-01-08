export const createRouter = ({ routes, onRoute }) => {
    const resolvePath = (path) => {
        if (routes[path]) return path;
        return "/not-found";
    };

    const navigate = (path) => {
        if (path === window.location.pathname) return;
        window.history.pushState({}, "", path);
        render(path);
    };

    const render = (path) => {
        const resolved = resolvePath(path);
        const view = routes[resolved] || routes["/"];
        if (typeof onRoute === "function") {
            onRoute(resolved, view, navigate);
        }
    };

    const handleLinkClick = (event) => {
        const link = event.target.closest("a[data-link]");
        if (!link) return;
        const url = new URL(link.href);
        if (url.origin !== window.location.origin) return;
        event.preventDefault();
        navigate(url.pathname);
    };

    window.addEventListener("popstate", () => render(window.location.pathname));
    document.addEventListener("click", handleLinkClick);

    render(window.location.pathname);

    return { navigate };
};
