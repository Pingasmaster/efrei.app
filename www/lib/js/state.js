export const createState = () => {
    const tokenKey = "efrei_token";
    let token = localStorage.getItem(tokenKey);
    let odds = [];
    let betslip = [];
    let oddsStatus = "offline";
    const listeners = new Set();

    const notify = () => {
        const snapshot = { token, odds, betslip, oddsStatus };
        listeners.forEach((listener) => listener(snapshot));
    };

    const setToken = (nextToken) => {
        token = nextToken;
        if (token) {
            localStorage.setItem(tokenKey, token);
        } else {
            localStorage.removeItem(tokenKey);
        }
        notify();
    };

    const clearToken = () => setToken(null);

    const setOdds = (nextOdds) => {
        odds = Array.isArray(nextOdds) ? nextOdds : [];
        notify();
    };

    const setOddsStatus = (status) => {
        oddsStatus = status || "offline";
        notify();
    };

    const addSlip = (selection) => {
        if (!selection || !selection.id) return;
        if (betslip.some((item) => item.id === selection.id)) return;
        betslip = [...betslip, selection];
        notify();
    };

    const removeSlip = (id) => {
        betslip = betslip.filter((item) => item.id !== id);
        notify();
    };

    const clearSlip = () => {
        betslip = [];
        notify();
    };

    const subscribe = (listener) => {
        listeners.add(listener);
        listener({ token, odds, betslip, oddsStatus });
        return () => listeners.delete(listener);
    };

    return {
        get token() {
            return token;
        },
        get odds() {
            return odds;
        },
        get betslip() {
            return betslip;
        },
        get oddsStatus() {
            return oddsStatus;
        },
        setToken,
        clearToken,
        setOdds,
        setOddsStatus,
        addSlip,
        removeSlip,
        clearSlip,
        subscribe
    };
};
