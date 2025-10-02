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

  async userAuthenticate() {
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
    await this.goto(
      'https://demo.index-education.net/pronote/mobile.eleve.html'
    )
    if (await this.isElementInWorker('.icon_off')) {
      this.log('info', 'Authenticated in pronote demo. Disconnecting...')
      await this.clickAndWait('.icon_off', 'main.deconnexion')
      await this.goto(
        'https://demo.index-education.net/pronote/mobile.eleve.html'
      )
    }
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
        interval: 1000,
        timeout: {
          milliseconds: 60 * 1000,
          message: new TimeoutError(
            `waitForLoginState timed out after ${60 * 1000}ms`
          )
        }
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

async function getUrlFromUser() {
  window.filterSchools = function () {
    window.setTimeout(() => {
      // timeout to have the input field updated
      const filter = document.querySelector('#filter').value
      if (filter?.length > 0) {
        document.querySelector('#schools').innerHTML = window.schoolPropositions
          .filter(school => school.nomEtab.includes(filter.toUpperCase()))
          .map(
            school =>
              `<option value="${school.url}">${school.nomEtab}</options>`
          )
          .join('\n')
      } else {
        document.querySelector('#schools').innerHTML = window.schoolPropositions
          .map(
            school =>
              `<option value="${school.url}">${school.nomEtab}</options>`
          )
          .join('\n')
      }
    }, 10)
  }
  async function getSelectedSchool(schools) {
    let schoolsTemplate = `
  <label for="filter">Sélectionnez un établissement</label><br>
  <input onchange="window.filterSchools()" onkeydown="window.filterSchools()" id="filter" type="text" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="full-width" />
  <select style="${window.SELECT_STYLE}" id="schools" name="schools" size="5" class="full-width">`
    schoolsTemplate += schools
      .map(school => `<option value="${school.url}">${school.nomEtab}</option>`)
      .join('\n')
    schoolsTemplate += `</select>`
    return getValues(
      schoolsTemplate,
      () => document.querySelector('#schools').value
    )
  }
  async function getSchoolPropositions(city) {
    const response = await fetch(
      'https://www.index-education.com/swie/geoloc.php',
      {
        method: 'POST',
        body: `data={"nomFonction":"geoLoc","lat":"${city.latitude}","long":"${city.longitude}"}`,
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8'
        }
      }
    )
    return await response.json()
  }
  async function getSelectedCity(cities) {
    let citiesTemplate = `<label for="cities" class="">Sélectionnez une ville</label><br>
  <select style="${window.SELECT_STYLE}" id="cities" name="cities" size="5" class="full-width">`
    citiesTemplate += cities
      .map(
        city =>
          `<option value="${city.id}">${city.name} (${city.postCode})</option>`
      )
      .join('\n')
    citiesTemplate += `</select>`
    return getValues(citiesTemplate, () =>
      cities.find(city => city.id === document.querySelector('#cities').value)
    )
  }
  async function getCityStringOrUrl() {
    const template = `
<div class="input-field">
  <input id="url" type="text" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="full-width" />
  <label for="url" class="">Saisissez directement l'url de votre ENT</label>
</div>
<div class="input-field">
  <input id="ville" type="text" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="full-width" />
  <label for="ville" class="">ou cherchez votre établissement par ville</label>
</div>`
    return getValues(template, () => ({
      city: document.querySelector('#ville').value,
      url: document.querySelector('#url').value
    }))
  }
  async function getCitiesPropositions(cityString) {
    const response = await fetch(
      'https://api-adresse.data.gouv.fr/search/?type=municipality&limit=15&q=' +
        cityString,
      {
        method: 'GET',
        mode: 'cors'
      }
    )
    const data = await response.json()
    return data.features.map(feature => ({
      id: feature.properties.id,
      name: feature.properties.city,
      postCode: feature.properties.postcode,
      latitude: feature.geometry.coordinates[1],
      longitude: feature.geometry.coordinates[0]
    }))
  }
  async function getValues(template, getter) {
    init()
    document.querySelector('#body').innerHTML =
      template +
      `
  <div class="btn-contain">
  <button id="cancelButton" class="themeBoutonNeutre ieBouton ie-ripple NoWrap ieBoutonDefautSansImage AvecMain">Recommencer</button>
  <button id="submitButton" class="themeBoutonPrimaire ieBouton ie-ripple NoWrap ieBoutonDefautSansImage AvecMain">Envoyer</button>
</div>
  `
    return new Promise((resolve, reject) => {
      document.querySelector('#cancelButton').addEventListener('click', () => {
        reject('CANCEL')
      })
      document.querySelector('#submitButton').addEventListener('click', () => {
        resolve(getter())
      })
    })
  }
  function init() {
    document.querySelector('main').innerHTML = `
  <fieldset class="login-contain">
    <h3 class="logo_pronote"><span>PRONOTE</span></h3>
    <div id="body" />
  </fieldset>
  `
    document.querySelector('nav')?.remove()
    document.querySelector('footer')?.remove()
  }

  while (true) {
    try {
      const { url, city } = await getCityStringOrUrl()
      if (url) {
        return cleanURL(url)
      } else if (city) {
        const citiesPropositions = await getCitiesPropositions(city)
        const selectedCity = await getSelectedCity(citiesPropositions)
        window.schoolPropositions = await getSchoolPropositions(selectedCity)
        const url = await getSelectedSchool(window.schoolPropositions)
        return url
      }
    } catch (err) {
      console.error(`ERROR: ${err.message}`, err)
    }
  }
}

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
