export const createOddsStream = ({ url, onMessage, onStatus }) => {
    let socket = null;
    let retryTimer = null;
    let attempts = 0;
    let shouldReconnect = true;

    const updateStatus = (status) => {
        if (typeof onStatus === "function") {
            onStatus(status);
        }
    };

    const connect = () => {
        if (!url) return;
        shouldReconnect = true;
        updateStatus("connecting");
        socket = new WebSocket(url);

        socket.addEventListener("open", () => {
            attempts = 0;
            updateStatus("connected");
        });

        socket.addEventListener("message", (event) => {
            if (typeof onMessage === "function") {
                try {
                    onMessage(JSON.parse(event.data));
                } catch {
                    onMessage(event.data);
                }
            }
        });

        socket.addEventListener("close", () => {
            updateStatus("disconnected");
            scheduleReconnect();
        });

        socket.addEventListener("error", () => {
            updateStatus("error");
            socket?.close();
        });
    };

    const scheduleReconnect = () => {
        if (!shouldReconnect) return;
        attempts += 1;
        const delay = Math.min(1000 * 2 ** attempts, 15000);
        clearTimeout(retryTimer);
        retryTimer = setTimeout(connect, delay);
    };

    const disconnect = () => {
        shouldReconnect = false;
        clearTimeout(retryTimer);
        retryTimer = null;
        socket?.close();
        socket = null;
        updateStatus("closed");
    };

    return { connect, disconnect };
};
