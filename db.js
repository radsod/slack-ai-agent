import pg from 'pg'
const { Pool } = pg
import dotenv from 'dotenv'
import { error } from 'node:console'
import { create } from 'node:domain'

dotenv.config()

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 20,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 20000
})

pool.on('connect', () => {
    console.log('[INFO] Database connected')
})

pool.on('error', () => {
    console.log('[ERROR] Unexpected database error:', error.message)
})

export async function initDatabase() {
    const client = await pool.connect()
    try {
        await client.query(`
            CREATE TABLE IF NOT EXISTS member_analyses (
                id SERIAL PRIMARY KEY,
                member_id VARCHAR(255),
                mamber_name VARCHAR(255) NOT NULL, 
                member_email VARCHAR(255),
                member_title VARCHAR(255),
                member_timezone VARCHAR(100),
                fit_score INTEGER NOT NULL,
                insight JSONB,
                recommendations JSONB,
                research_data JSONB,
                analyzed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                sent_to_slack BOOLEAN DEFAULT FALSE,
                sent_to_slack_at TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )` 
        )
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_member_id ON member_analyses(member_id)
        `)
        await client.query(`
            CREATE INDEX IF NOT EXISTS idx_analyzed_id ON member_analyses(analyzed_at)
        `)
        console.log('[INFO] Database schema initialized')
    } catch (error) {
        console.log('[ERROR] Failed to initialize database:', error.message)
        throw error
    } finally {
        client.release()
    }
}
export async function saveMemberAnalysis(memberInfo, analysis, researchData) {
    try {
        const result = await client.query(`
        INSERT INTO member_analyses (
            member_id,
            member_name,
            member_email,
            member_title,
            member_timezone,
            fit_score,
            insights,
            recommendations,
            research_data
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) 
            RERTURNING id`,
            [
            memberInfo.id || null,
            memberInfo.name,
            memberInfo.email || null,
            memberInfo.title || null,
            memberInfo.timezone || null,
            analysis.fitScore,
            JSON.stringify(analysis.insights),
            JSON.stringify(analysis.recomendations),
            JSON.stringify(researchData)
            ]
        )

        console.log(`[INFO] Saved analysis to database with ID: ${result.rows[0].id}`)
        return result.rows[0].id
    } catch (error) {
        console.error('[ERROR] Failed to save analysis to database:', error.message)
        throw error
    } finally {
        client.release()
    }
}

export async function markAsSentToSlack(analysisId) {
    const client = await pool.connect()
    try {
        await client.query(`
            UPDATE member_analyses
            SET sent_to_slack = TRUE,
                sent_to_slack_at = CURRENT_TIMESTAMP,
                update_at = CURRENT_TIMESTAMP
            WHERE id = $1`, [analysis]
            )
    } catch (error) {
        console.log('[ERROR] Failed to mark as sent to Slack:', error.message)
    } finally {
        client.release()
    }
}

export async function closeDatabase() {
    await pool.end()
    console.log('[INFO] Database connection pool closed')
}

export default pool