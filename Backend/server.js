const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");

const app = express();

const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.json());


// =====================================
// MYSQL CONNECTION POOL
// =====================================

// DB_HOST/DB_PORT point at MySQL Router (port 6446 = current PRIMARY),
// never at a single MySQL node
const db = mysql.createPool({
    host: process.env.DB_HOST || "mysql-router",
    port: Number(process.env.DB_PORT || 6446),
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME || "userdb",

    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,

    // Fail fast on a dead node instead of hanging, and keep idle
    // connections alive so broken ones are noticed quickly
    connectTimeout: 10000,
    enableKeepAlive: true,
    keepAliveInitialDelay: 10000
});


// =====================================
// RETRY ON TRANSIENT FAILOVER ERRORS
// =====================================

// Errors that happen while the cluster elects a new PRIMARY.
// They are temporary, so we wait and retry instead of failing the request.
const TRANSIENT_ERRORS = new Set([
    "PROTOCOL_CONNECTION_LOST",     // Router/MySQL closed the connection
    "ECONNREFUSED",                 // Router has no PRIMARY to send us to yet
    "ECONNRESET",
    "ETIMEDOUT",
    "EPIPE",
    "ER_OPTION_PREVENTS_STATEMENT", // 1290: node became read-only
    "ER_SERVER_SHUTDOWN",           // 1053: node is shutting down
    "ER_CON_COUNT_ERROR"
]);

// 3100/3101: Group Replication rolled the transaction back during the election
const TRANSIENT_ERRNOS = new Set([3100, 3101]);

const MAX_ATTEMPTS = 6;      // 1+2+3+4+5 s = ~15 s of waiting in total
const RETRY_STEP_MS = 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isTransient(error) {
    return TRANSIENT_ERRORS.has(error.code) || TRANSIENT_ERRNOS.has(error.errno);
}

async function dbExecute(sql, params = []) {

    for (let attempt = 1; ; attempt++) {

        try {

            return await db.execute(sql, params);

        } catch (error) {

            if (!isTransient(error) || attempt >= MAX_ATTEMPTS) {
                throw error;
            }

            const delay = RETRY_STEP_MS * attempt;

            console.warn(
                `DB transient error (${error.code}), retry ${attempt}/${MAX_ATTEMPTS - 1} in ${delay} ms`
            );

            await sleep(delay);
        }
    }
}


// =====================================
// INITIALIZE DATABASE
// =====================================

// Keeps retrying until the database is reachable instead of exiting,
// so the backend survives starting before MySQL/Router are ready
async function initializeDatabase() {

    for (let attempt = 1; ; attempt++) {

        try {

            await db.query(`
                CREATE TABLE IF NOT EXISTS users (
                    id INT AUTO_INCREMENT PRIMARY KEY,
                    username VARCHAR(255) UNIQUE NOT NULL,
                    password VARCHAR(255) NOT NULL,
                    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
                )
            `);

            console.log("MySQL database connected, users table ready");

            return;

        } catch (error) {

            console.error(
                `Database not ready (attempt ${attempt}): ${error.code || error.message}. Retrying in 5 s`
            );

            await sleep(5000);
        }
    }
}


// =====================================
// REGISTER
// =====================================

app.post("/api/register", async (req, res) => {

    const { username, password } = req.body;

    if (!username || !password) {

        return res.status(400).json({
            message: "Username and password are required"
        });

    }

    try {

        await dbExecute(
            `
            INSERT INTO users (username, password)
            VALUES (?, ?)
            `,
            [username, password]
        );

        console.log(
            `User registered: ${username}`
        );

        res.json({
            message: "User created successfully"
        });

    } catch (error) {

        if (error.code === "ER_DUP_ENTRY") {

            return res.status(400).json({
                message: "Username already exists"
            });

        }

        console.error(
            "Database error:",
            error
        );

        res.status(500).json({
            message: "Database error"
        });

    }

});


// =====================================
// LOGIN
// =====================================

app.post("/api/login", async (req, res) => {

    const { username, password } = req.body;

    if (!username || !password) {

        return res.status(400).json({
            message: "Username and password are required"
        });

    }

    try {

        const [rows] = await dbExecute(
            `
            SELECT *
            FROM users
            WHERE username = ?
            `,
            [username]
        );

        if (rows.length === 0) {

            return res.status(401).json({
                message: "Invalid username or password"
            });

        }

        const user = rows[0];

        // Plain-text comparison for your current project
        if (password !== user.password) {

            return res.status(401).json({
                message: "Invalid username or password"
            });

        }

        console.log(
            `User logged in: ${username}`
        );

        res.json({
            message: "Login successful",
            username: user.username
        });

    } catch (error) {

        console.error(
            "Database error:",
            error
        );

        res.status(500).json({
            message: "Database error"
        });

    }

});


// =====================================
// HEALTH CHECK
// =====================================

app.get("/api/health", async (req, res) => {

    try {

        await db.query("SELECT 1");

        res.json({
            status: "UP",
            database: "MySQL"
        });

    } catch (error) {

        res.status(500).json({
            status: "DOWN",
            database: "MySQL"
        });

    }

});


// =====================================
// START SERVER
// =====================================

// Start HTTP first so /api/health can report DOWN while the database
// is still coming up, then connect to the database in the background
function startServer() {

    app.listen(
        PORT,
        "0.0.0.0",
        () => {

            console.log(
                `Backend running on port ${PORT}`
            );

        }
    );

    initializeDatabase();
}

// Log instead of crashing on an unexpected async error
process.on("unhandledRejection", (error) => {
    console.error("Unhandled rejection:", error);
});

startServer();