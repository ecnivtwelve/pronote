/* eslint no-constant-condition: off */
/* eslint no-console: off */

import { ContentScript } from 'cozy-clisk/dist/contentscript'
import Minilog from '@cozy/minilog'
import waitFor, { TimeoutError } from 'p-wait-for'

import template from './utils/templates/pronote.html?raw'

const DESKTOP_USER_AGENT =
  'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Mobile Safari/537.36'

const log = Minilog('ContentScript')

Minilog.enable()

const UUID = uuid()

monkeyPatch(UUID)

window.SELECT_STYLE =
  'border-bottom: 1px solid var(--theme-foncee); box-shadow: 0 1px 0 0 var(--theme-foncee); width: 100%; padding: .4rem; padding-left: 2rem; font-size: var(--taille-m); margin: 0 0 .25rem 0;'

  function cleanURL(url) {
    let pronoteURL = url
    if (
      !pronoteURL.startsWith('https://') &&
      !pronoteURL.startsWith('http://')
    ) {
      pronoteURL = `https://${pronoteURL}`
    }

    pronoteURL = new URL(pronoteURL)
    // Clean any unwanted data from URL.
    pronoteURL = new URL(
      `${pronoteURL.protocol}//${pronoteURL.host}${pronoteURL.pathname}`
    )

    // Clear the last path if we're not main selection menu.
    const paths = pronoteURL.pathname.split('/')
    if (paths[paths.length - 1].includes('.html')) {
      paths.pop()
    }

    // Rebuild URL with cleaned paths.
    pronoteURL.pathname = paths.join('/')

    // Return rebuilt URL without trailing slash.
    return pronoteURL.href.endsWith('/')
      ? pronoteURL.href.slice(0, -1)
      : pronoteURL.href
  }

class PronoteContentScript extends ContentScript {
  async ensureAuthenticated({ account, trigger }) {
    this.log('info', '🤖 ensureAuthenticated')
    const isLastJobError =
      trigger?.current_state?.last_failure >
      trigger?.current_state?.last_success
    this.log('debug', 'isLastJobError: ' + isLastJobError)
    const lastJobError = trigger?.current_state?.last_error
    this.log('debug', 'lastJobError: ' + lastJobError)

    await this.setWorkerState({ incognito: true })
    log('info', 'Setting user agent')
    await this.bridge.call('setUserAgent', DESKTOP_USER_AGENT)
    const url = account?.data?.url
    this.log('debug', 'url: ' + url)
    const needsUserAuthenticate =
      !url || (isLastJobError && lastJobError === 'LOGIN_FAILED')
    if (needsUserAuthenticate) {
      await this.userAuthenticate()
    } else {
      this.store = account?.data
    }

    return true
  }

  async requestUrl() {
    this.log('info', '🤖 requestUrl')
    await this.setWorkerState({ incognito: true })
    await this.goto(
      'data:text/html,' + encodeURIComponent(template)
    )
    await this.waitForElementInWorker('.MuiList-root')
    await this.setWorkerState({ visible: true })
    await this.waitForElementInWorker('.cozy-client-brige-url')
    const json = await this.evaluateInWorker(() => {
      return document.querySelector('.cozy-client-brige-url').innerText.trim()
    })
    const { url } = JSON.parse(json)
    await this.setWorkerState({ visible: false })
    return cleanURL(url)
  }

  async checkAuthenticated() {
    this.log('info', '🤖 checkAuthenticated')
    return false;
  }

  async userAuthenticate() {
    this.log('info', '🤖 userAuthenticate')
    await this.ensureNotAuthenticated()
    const url = await this.requestUrl()
    await this.goto(
      url + '/infoMobileApp.json?id=0D264427-EEFC-4810-A9E9-346942A862A4'
    )
    await new Promise(resolve => window.setTimeout(resolve, 2000))
    await this.evaluateInWorker(function (UUID) {
      const PRONOTE_COOKIE_EXPIRED = new Date(0).toUTCString()
      const PRONOTE_COOKIE_VALIDATION_EXPIRES = new Date(
        new Date().getTime() + 5 * 60 * 1000
      ).toUTCString()
      const PRONOTE_COOKIE_LANGUAGE_EXPIRES = new Date(
        new Date().getTime() + 365 * 24 * 60 * 60 * 1000
      ).toUTCString()
      const json = JSON.parse(document.body.innerText)
      const lJetonCas = !!json && !!json.CAS && json.CAS.jetonCAS
      document.cookie = `appliMobile=; expires=${PRONOTE_COOKIE_EXPIRED}`

      if (lJetonCas) {
        document.cookie = `validationAppliMobile=${lJetonCas}; expires=${PRONOTE_COOKIE_VALIDATION_EXPIRES}`
        document.cookie = `uuidAppliMobile=${UUID}; expires=${PRONOTE_COOKIE_VALIDATION_EXPIRES}`
        document.cookie = `ielang=1036; expires=${PRONOTE_COOKIE_LANGUAGE_EXPIRES}`
      }
    }, UUID)
    await this.goto(`${url}/mobile.eleve.html?fd=1`)

    await this.waitForDomReady()
    await this.setWorkerState({ visible: true })
    await this.runInWorkerUntilTrue({
      method: 'waitForLoginState'
    })
    await this.setWorkerState({ visible: false })
    const loginState = await this.evaluateInWorker(() => window.loginState)

    const loginTokenParams = {
      url,
      kind: 6,
      login: loginState.login,
      token: loginState.mdp,
      deviceUUID: UUID
    }
    this.store = loginTokenParams
  }

  async ensureNotAuthenticated() {
    this.log('info', '🤖 ensureNotAuthenticated')
    await this.setWorkerState({ incognito: true })
    return true
  }

  async getUserDataFromWebsite() {
    this.log('info', '🐛🐛🐛 this.store ' + JSON.stringify(this.store, null, 2))
    this.log('info', '🤖 getUserDataFromWebsite')
    return {
      sourceAccountIdentifier: this.store.login
    }
  }

  async fetch({ account }) {
    this.log('info', '🤖 fetch')
    if (!this.bridge) {
      throw new Error(
        'No bridge is defined, you should call ContentScript.init before using this method'
      )
    }

    await this.bridge.call('saveAccountData', this.store)
    const jobResult = await this.bridge.call('runServerJob', {
      mode: 'pronote-server',
      account: account._id
    })
    if (jobResult.error) {
      throw new Error(jobResult.error)
    }
  }

  async waitForLoginState() {
    this.log('debug', '🔧 waitForLoginState')
    await waitFor(
      () => {
        return Boolean(window.loginState)
      },
      {
        interval: 1000
      }
    )
    return true
  }
}

const connector = new PronoteContentScript()
connector
  .init({ additionalExposedMethodsNames: ['waitForLoginState'] })
  .catch(err => {
    log.warn(err)
  })

function monkeyPatch(uuid) {
  window.hookAccesDepuisAppli = function () {
    this.passerEnModeValidationAppliMobile('', uuid)
  }
}

function uuid() {
  let dateTime = new Date().getTime()

  const uuid = 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (dateTime + Math.random() * 16) % 16 | 0
    dateTime = Math.floor(dateTime / 16)
    return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
  })

  return uuid
}
