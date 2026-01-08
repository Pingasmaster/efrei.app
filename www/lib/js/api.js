export const createApi = ({ baseUrl, state }) => {
    const request = async (path, options = {}) => {
        const headers = new Headers(options.headers || {});
        headers.set("Content-Type", "application/json");

        if (state?.token) {
            headers.set("Authorization", `Bearer ${state.token}`);
        }

        const response = await fetch(`${baseUrl}${path}`, {
            ...options,
            headers
        });

        const data = await response.json().catch(() => ({}));
        if (!response.ok) {
            const message = data?.message || "Request failed";
            throw new Error(message);
        }
        return data;
    };

    const login = (payload) => request("/auth/login", {
        method: "POST",
        body: JSON.stringify(payload)
    });

    const register = (payload) => request("/auth/register", {
        method: "POST",
        body: JSON.stringify(payload)
    });

    return { request, login, register };
};
