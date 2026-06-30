import pkg from '@slack/bolt'
const { App } = pkg
import { WebClient } from '@slack/web-api'
import { ChatOpenAI } from '@langchain/openai'
import { ChatPromptTemplate } from '@langchain/core/prompts'
import express from 'express'
import dotenv from 'dotenv'
import axios from 'axios'
import { respondToSslCheck } from '@slack/bolt/dist/receivers/ExpressReceiver.js'
import { error, profile, timeStamp } from 'node:console'
import { title } from 'node:process'
import { json, text } from 'node:stream/consumers'
import { type } from 'node:os'
import { initDatabase, saveMemberAnalysis, markAsSentToSlack, closeDatabase } from './db.js'

dotenv.config()

const log = {
    info: (msg, ...args) => console.log(`[INFO] ${msg}`, ...args),
    error: (msg, ...args) => console.log(`[ERROR] ${msg}`, ...args),
    debug: (msg, ...args) => process.env.NODE_ENV === "development" && console.log(`[DEBUG] ${msg}`, ...args)
}

class SlackAIAgent {
    constructor() {
        this.app = express()
        this.slack = new App({
            token: process.env.SLACK_BOT_TOKEN,
            signingSecret:  process.env.SLACK_SIGNING_SECRET,
            sockedMode: true,
            appToken: process.env.SLACK_APP_TOKEN
        })
        this.WebClient = new WebClient(process.env.SLACK_BOT_TOKEN)
        this.openai = new ChatOpenAI({
            model: "gpt-4",
            temperature: 0.3,
            apiKey: process.env.OPEN_AI_KEY
        })

        this.setupSlackEvents()
        this.setupExpress()
    }

    setupSlackEvents() {
        this.slack.event('team_join', async ({ event }) => {
            try {
                log.info(`New member joined: ${event.user.real_name || event.user.name}`)
                const userInfo = await this.getUserInfo(event.user.id)
                await this.analyzeAndPostMember(userInfo)
            } catch(error) {
                log.error('Error process team_join:', error.message)
            }
        })
        this.slack.event('member_joined_channel', async ({ event }) => {
            try {
                if(event.channel_type === 'C') {
                    log.info(`Member: ${event.user} joined channel ${event.channel}`)
                    const userInfo = await this.getUserInfo(event.user)
                    await this.analyzeAndPostMember(userInfo)
                }
            } catch(error) {
                log.error('Error processing member_joined_channel:', error.message)
            }
        })
        this.slack.error(async (error) => log.error('Slack error:', error.message))
    }

    setupExpress() {
        this.app.use(express.json())

        this.app.get('/health', (req, res) => {
           res.json({ status: 'healthy', timestamp: new Date().toISOString() }) 
        })

        if(process.env.NODE_ENV === 'development') {
        this.app.post('test/analyze-member', async (req, res) => {
                try {
                    const { memberInfo } = req.body
                    if(!memberInfo) return res.status(400).json({ error: 'memberInfo is required' })
                    const analysis = await this.analyzeAndPostMember(memberInfo)
                    res.json({ succes: true, analysis, timestamp: new Date().toDateString() })

                } catch (error) {
                    log.error('Test analysis error', error.message)
                    res.status(500).json({ error: 'Analysis failed', message: error.message})
                }
            })
        }

        this.app.use((err, req, res, next) => {
            log.error('Express error', err.message)
            res.status(500).json({ error: 'Internal server error'})
        })
    }

    async getUserInfo(userId) {
        const result = await this.WebClient.users.info({ user: userId })
        const user = result.user

        return {
            id: user.id,
            name: user.real_name || user.name,
            username: user.name,
            email: user.profile?.email,
            title: user.profile?.title,
            timezone: user.tz,
            profile: {
                firsName: user.profile?.first_name,
                lastName: user.profile?.last_name,
                statusText: user.profile?.status_text
            }
        }
    }

    async analyzeAndPostMember(memberInfo) {
        let analysisId = null
        try {
            log.info(`Processing member: ${memberInfo.name}`)
            const reaserchData = await this.doBasicResearch(memberInfo)
            const analysis = await this.analyzeWithAI(memberInfo, reaserchData)
            log.info(`Saving analysis to db for ${memberInfo.name}`)
            analysisId = await saveMemberAnalysis(memberInfo, analysis, reaserchData)
            await this.postAnalysisToChanel(memberInfo, analysis, reaserchData)
            if(analysisId) {
                await markAsSentToSlack(analysisId)
            }
        } catch (error) {
            log.error(`Error processing ${memberInfo.name}:`, error.message)
            if(analysisId) {
                log.info(`Analysis ${analysisId} saved to db but not sent to Slack due to error`)
            }
            throw error
        }
    }

    async doBasicResearch(memberInfo) {
        const results = [] 
        try {
            if(memberInfo.email && !this.isPersonalEmail(memberInfo.email)) {
                const domain = memberInfo.email.split('@')[1]
                const companyInfo = await this.getCompanyInfo(domain)
                if(companyInfo) results.push(companyInfo)
                
                if(companyInfo.name) {
                    const githubInfo = await this.getGitHubInfo(memberInfo.name)
                    if(githubInfo) results.push(githubInfo)
                }
            }
        } catch (error) {
            log.error('Research error:', error.message)
        }
        return results
    }

    async getCompanyInfo(domain) {
        try {
            const response = await axios.get(`http://www.${domain}`, {
                timeout: 5000,
                headers: { 'User-Agent': 'Mozilla/5.0'}
            })

            const titleMatch = response.data.match(/<title>(.*?)<\/title>/i)
            const title = titleMatch ? titleMatch[1] : `Company: ${domain}`

            return {
                url: `http://www.${domain}`,
                title: title,
                content: `Company website for ${domain}`,
                type: 'company'
            }
        } catch (error) {
            log.error(`Could not fetch ${domain}:`, error.message)
            return null
        }
    }

    async getGitHubInfo(name) {
        try {
            const response = await axios.get(
                `https://api.github.com/search/users?q=${encodeURIComponent(name)}`,
                { timeout: 5000 }
            )

                if(response.data.items && response.data.items.length > 0) {
                    const user = response.data.items[0]
                    return {
                        url: user.html_url,
                        title: `GitHub: ${user.login}`,
                        content: `${user.public_repos} public repositories`,
                        type: 'github'
                    }
                }
        } catch (error) {
            log.debug('GitHub search error:', error.message)
        }
        return null
    }

    async analyzeWithAI(memberInfo, reaserchData) {
        const prompt = ChatPromptTemplate.fromTemplate(
            `Analyze this new community member for fit with our commercial product.
            
            Company: ${process.env.COMPANY_NAME || 'Your Company'}
            Product: ${process.env.COMPANY_PRODUCT || 'Your Product'}

            Member:
            - Name: {name}
            - Email: {email}
            - Title: {title}

            Research Data:
            {research}

            Provide a JSON response with:
            - fitScore (0-100): likelihood they'd be interesed in our product
            - insights: array of 3-5 key observations
            - recommendations: array of 2-4 engagement suggestions

            Consider job title, company size, technical background, and budget authority.`
        )

        try {
            const researchSummary = reaserchData.length > 0 ? reaserchData.map(r => `${r.title}: ${r.content}`).join(`\\n`) : 'limited research data available'

            const chain = prompt.pipe(this.openai)
            const result = await chain.invoke({
                name: memberInfo.name,
                email: memberInfo.email || 'Not provided',
                title: memberInfo.title || 'Not provided',
                research: researchSummary
            })

            const responseText = result.content || result
            const cleanedResponse = responseText.replace(/```json\\?|\\n?```/g, '').trim()
            const analisis = JSON.parse(cleanedResponse)

            return {
                fitScore: Math.max(0, Math.min(100, analisis.fitScore || 50)),
                insights: Array.isArray(analisis.insights) ? analisis.insights : ['Analysis is complited'],
                recomendations: Array.isArray(analisis.recomendations) ? analisis.recomendations : ['Follow up recommended']
            }
        } catch (error) {
            log.error('AI analysis error:', error.message)
            return {
                fitScore: 50,
                insights: ['Unable to complete full analysis'],
                recomendations: ['Manual review recommended']
            }
        }
    }

    async postAnalysisToChanel(member, analisis, reaserchData) {
        const color = analysis.fitScore >= 80 ? '#36a64f' 
        : analisis.fitScore >= 60 ? '#ffb84d' 
        : analisis.fitScore >= 40 ? 'ff9500' : '#ff4444'

        const blocks = [
            {
                type: 'header',
                text: { type: 'plain_text', text: `🔍 New Member: ${member.name}` }
            },
            {
                type: 'section',
                fields:  [
                    { type: 'mrkdwn', text: `*Fit Scoree:* ${analisis.fitScore}/100`},
                    { type: 'mrkdwn', text: `*Email:* ${member.email} || 'Not provided`},
                    { type: 'mrkdwn', text: `*Title:* ${member.title} || 'Not provided`},
                ]
            }
        ]

        if(analisis.insights.length > 0) {
            blocks.type({
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Insights:*\\n${analisis.insights.map(i => `* ${i}`).join('\\n')}`
                }
            })
        }

        if(analisis.recommendations.length > 0) {
            blocks.type({
                type: 'section',
                text: {
                    type: 'mrkdwn',
                    text: `*Recommendations:*\\n${analisis.recomendations.map(i => `* ${i}`).join('\\n')}`
                }
            })
        }

        blocks.push({
            type: 'context',
            text: `Analyzed: ${new Date.toISOString()}`
        })
        
        await this.WebClient.chat.postMessage({
            channel: process.env.SLACK_PRIVATE_CHANNEL_ID,
            text: `New Member Analysis: ${member.name} (${analisis.fitScore}/100)`,
            blocks
        })

        log.info(`Analysis posted to channel for ${member.name}`)
    }

    isPersonalEmail(email) {
        const personalDomains = ['gmail.con', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com']
        const domain = email.split('@')[1]?.toLowerCase()
        return personalDomains.includes(domain)
    }

    async start() {
        try {
            log.info('🗄️  Initilazing database...')
            await initDatabase()

            const port = process.env.PORT || 3000
            this.server =  this.app.listen(port, () => {
                log.info(`🚀 Express server running on port ${port}`)
            })

            await this.slack.start()
            log.info('⚡ Slack bot connected')

            log.info('⚙️  Slack AI is still running!')

            if(process.env.NODE_ENV === 'development') {
                log.info(`Test endpoint: POST http://localhost:${port}/test/analyze-member`)
            }
            
        } catch (error) {
            log.error('Failed to start', error.message)
            process.exit(1)
        }  
    }

    async stop() {
        log.info('Shutting down...')
        try {
            await this.slack.stop()
            if(this.server) {
                await new Promise(resolve => this.server.close(resolve))
            }
            await closeDatabase()
            log.info('Stopped successfully')
        } catch (error) {
            log.error('Shutdown error:', error.message)
        }
        process.exit(0)
    }
}

const agent = new SlackAIAgent() 

process.on('SIGINT', () => agent.stop())
process.on('SIGTERM', () => agent.stop())

agent.start().catch(error => {
    console.log('Startup failed:', error.message)
    process.exit(1)
})

export default agent