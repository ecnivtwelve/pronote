process.env.SENTRY_DSN =
  process.env.SENTRY_DSN ||
  'https://417de448d3ca82b66be0698f6ad71d2b@errors.cozycloud.cc/77'

// Importation des fonctions de cozy-konnector-libs
const { BaseKonnector, log } = require('cozy-konnector-libs')

// Importation de la fonction Pronote
const { Pronote } = require('./fetch/session')

// Importation de la fonction cozy_save
const { cozy_save } = require('./cozy')

// Exportation de la fonction start
module.exports = new BaseKonnector(start)

// Variable globale pour savoir si on doit sauvegarder les fichiers
const SHOULD_SAVE = true
const SHOULD_GET_LESSON_CONTENT = false // ONLY for small requests, sends a request per course to get the content of the lesson
const SAVES = [
  'timetable',
  'homeworks',
  'grades',
  'presence'
]

// Fonction start qui va être exportée
async function start(fields) {
  try {
    log('info', 'Starting Pronote connector')

    // Initialisation de la session Pronote
    await this.deactivateAutoSuccessfulLogin()
    const accountData = this.getAccountData()
    if (process.node_env === 'standalone' && !accountData.token) {
      // Use konnector-dev-config.json fields in standalone mode
      Object.assign(accountData, fields)
    }
    const { session, loginResult } = await Pronote(accountData)
    await this.saveAccountData({
      ...accountData,
      token: loginResult.token,
      navigatorIdentifier: loginResult.navigatorIdentifier
    })
    await this.notifySuccessfulLogin()

    log('info', 'Pronote session initialized successfully')

    // Gets school year dates
    let dateFrom = offsetDate(new Date(session.instance.firstDate))
    let dateToday = offsetDate(new Date())
    const dateTo = offsetDate(new Date(session.instance.lastDate))

    // Saves user identity
    const envFields = JSON.parse(process.env.COZY_FIELDS || '{}')
    await cozy_save('identity', session, {
      ...fields,
      ...accountData,
      ...envFields
    })

    SAVES.forEach(async save => {
      await cozy_save(
        save,
        session,
        { ...fields, ...accountData, ...envFields },
        {
          dateFrom: SAVES === 'homeworks' ? dateToday : dateFrom,
          dateTo: dateTo,
          saveFiles: SHOULD_SAVE && true,
          getLessonContent: SHOULD_GET_LESSON_CONTENT
        }
      )
    })
  } catch (err) {
    const error = err.toString()
    log('error', error)

    if (error.trim() === "Error: You've been rate-limited.") {
      // Pronote temporarily blocked the IP address
      // (usually 5 min/60 requests or 5 min/5 failed login attempts)
      throw new Error('VENDOR_DOWN')
    } else if (
      error.trim() === 'Error: Your username or password is incorrect.'
    ) {
      // Pronote failed to login
      throw new Error('LOGIN_FAILED')
    } else if (error.includes('Invalid URL')) {
      // Pronote URL is invalid
      throw new Error('LOGIN_FAILED')
    } else if (
      JSON.stringify(err).toString().includes('Wrong user credentials')
    ) {
      // Toutatice / Educonnect failed to login
      throw new Error('LOGIN_FAILED')
    } else if (
      JSON.stringify(err).toString().includes('Unable to resolve the challenge')
    ) {
      // Toutatice / Educonnect failed to login
      throw new Error('LOGIN_FAILED')
    } else if (error.includes('TOUTATICE_ERR')) {
      // If TOUTATICE_ERR is thrown, the IP address is suspended OR Pronote / Toutatice / Educonnect is down
      throw new Error('VENDOR_DOWN')
    }

    throw new Error('UNKNOWN_ERROR')
  }
}

function offsetDate(date) {
  const timestamp = date.getTime()
  const offset = date.getTimezoneOffset() * 60 * 1000
  return new Date(timestamp - offset)
}
