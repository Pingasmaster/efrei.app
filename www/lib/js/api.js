export const createApi = ({ baseUrl, state }) => {
    const buildHeaders = (options = {}) => {
        const headers = new Headers(options.headers || {});
        headers.set("Content-Type", "application/json");
        if (state?.token) {
            headers.set("Authorization", `Bearer ${state.token}`);
        }
        return headers;
    };

    const refreshSession = async () => {
        if (!state?.refreshToken) return false;
        try {
            const response = await fetch(`${baseUrl}/auth/refresh`, {
                method: "POST",
                headers: buildHeaders(),
                body: JSON.stringify({ refreshToken: state.refreshToken })
            });
            const data = await response.json().catch(() => ({}));
            if (!response.ok || !data?.token) {
                return false;
            }
            state.setToken(data.token);
            if (data.refreshToken) {
                state.setRefreshToken(data.refreshToken);
            }
            return true;
        } catch {
            return false;
        }
    };

    const request = async (path, options = {}, attemptRefresh = true) => {
        const headers = buildHeaders(options);
        const response = await fetch(`${baseUrl}${path}`, {
            ...options,
            headers
        });

        const data = await response.json().catch(() => ({}));
        if (response.status === 401 && attemptRefresh && state?.refreshToken && !path.startsWith("/auth/")) {
            const refreshed = await refreshSession();
            if (refreshed) {
                return request(path, options, false);
            }
            if (typeof state?.clearAuth === "function") {
                state.clearAuth();
            } else {
                state.setToken(null);
                if (typeof state?.setRefreshToken === "function") {
                    state.setRefreshToken(null);
                }
            }
        }
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
