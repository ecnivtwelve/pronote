const { saveFiles, updateOrCreate, log } = require('cozy-konnector-libs')
const { gradesOverview: getGradesOverview, gradebookPDF } = require('pawnote')

const {
  DOCTYPE_GRADE,
  PATH_GRADE_SUBJECT,
  PATH_GRADE_CORRECTION,
  PATH_GRADE_REPORT
} = require('../../constants')

const findObjectByPronoteString = require('../../utils/format/format_cours_name')
const preprocessDoctype = require('../../utils/format/preprocess_doctype')
const { queryAllGrades } = require('../../queries')

async function get_grades(session) {
  const allGrades = []

  // Get all periods (trimesters, semesters, etc.)
  const periods = session.instance.periods

  // For each period, get all grades
  for (const period of periods) {
    // Get all grades for each period
    const gradesOverview = await getGradesOverview(session, period)

    // For each grade, get the subject and add it to the list
    for (const grade of gradesOverview.grades) {
      // Get the subject of the grade
      const subject = grade.subject

      // Find the subject in the list of all subjects
      const subjectIndex = allGrades.findIndex(
        item => item.subject?.name === subject?.name && item.period === period
      )

      // If the subject is not yet in the list, add it
      if (subjectIndex === -1) {
        allGrades.push({
          subject: subject,
          period: period,
          averages: gradesOverview.subjectsAverages.find(
            avg => avg.subject?.name === subject?.name
          ),
          grades: [grade]
        })
      } else {
        allGrades[subjectIndex].grades.push(grade)
      }
    }
  }

  // Return the list of all grades
  return allGrades
}

async function getReports(session) {
  const allReports = []

  // Get all reports
  const periods = session.instance.periods
  for (const period of periods) {
    try {
      const reportURL = await gradebookPDF(session, period)
      allReports.push({
        period: period?.name,
        url: reportURL
      })
    } catch (error) {
      log('warn', 'Could not fetch report for period:', period?.name)
    }
  }

  return allReports
}

async function saveReports(pronote, fields) {
  const reports = await getReports(pronote)
  const filesToDownload = []

  for (const report of reports) {
    const extension = 'pdf'
    let fileName = `Bulletin du ${report.period}`

    filesToDownload.push({
      filename: `${fileName}.${extension}`,
      fileurl: report.url,
      shouldReplaceFile: false,
      subPath: PATH_GRADE_REPORT,
      fileAttributes: {
        created_at: new Date(),
        updated_at: new Date()
      }
    })
  }

  const data = await saveFiles(filesToDownload, fields, {
    sourceAccount: fields.account,
    sourceAccountIdentifier: fields.login,
    concurrency: 3,
    qualificationLabel: 'gradebook', // Grade report
    validateFile: () => true
  })

  return data
}

async function createGrades(session, fields, options) {
  // Get all grades
  const grades = await get_grades(session, fields, options)
  const data = []

  // Get options
  let shouldSaveFiles = options['saveFiles']
  if (shouldSaveFiles === undefined || shouldSaveFiles === null) {
    shouldSaveFiles = true
  }

  log(
    'info',
    `[Grades] : 💾 Saving ${shouldSaveFiles ? 'enabled' : 'disabled'}`
  )

  // For each grade, create a doctype
  for (const grade of grades) {
    const pronoteString = findObjectByPronoteString(grade.subject?.name)
    const processedCoursName = pronoteString.label
    const prettyCoursName = pronoteString.pretty

    let subjectFiles = []
    let correctionFiles = []

    // Files
    const evals = []

    // For each file, save it and add it to the list of files
    for (const evl of grade.grades) {
      const id =
        new Date(evl.date).getTime() +
        '_' +
        processedCoursName +
        '_' +
        (evl.comment
          .replace(/\s+/g, '')
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .replace(/[^a-zA-Z0-9]/g, '') || 'grd')

      if (evl.subjectFile && evl.subjectFile.url && shouldSaveFiles) {
        const filesToDownload = []

        const date = new Date(evl.date)
        const prettyDate = date.toLocaleDateString('fr-FR', {
          month: 'short',
          day: '2-digit',
          weekday: 'short'
        })

        const extension = evl.subjectFile.name.split('.').pop()
        let fileName =
          evl.subjectFile.name.replace(/\.[^/.]+$/, '') + ` (${prettyDate})` ||
          'Rendu devoir du ' + prettyDate

        filesToDownload.push({
          filename: `${fileName}.${extension}`,
          fileurl: evl.subjectFile.url,
          shouldReplaceFile: false,
          subPath: PATH_GRADE_SUBJECT.replace('{subject}', prettyCoursName),
          fileAttributes: {
            created_at: date,
            updated_at: date
          }
        })

        const data = await saveFiles(filesToDownload, fields, {
          sourceAccount: fields.account,
          sourceAccountIdentifier: fields.login,
          concurrency: 3,
          qualificationLabel: 'other_work_document', // Given subject
          validateFile: () => true
        })

        for (const file of data) {
          if (file['fileDocument']) {
            subjectFiles.push({
              resource: {
                data: {
                  _id: file['fileDocument']['_id'],
                  _type: 'io.cozy.files',
                  metadata: {
                    gradeId: id
                  }
                }
              }
            })
          }
        }
      }

      if (evl.correctionFile && evl.correctionFile.url && shouldSaveFiles) {
        const filesToDownload = []

        const date = new Date(evl.date)
        const prettyDate = date.toLocaleDateString('fr-FR', {
          month: 'short',
          day: '2-digit',
          weekday: 'short'
        })

        const extension = evl.correctionFile.name.split('.').pop()
        let fileName =
          evl.correctionFile.name.replace(/\.[^/.]+$/, '') +
            ` (${prettyDate})` || 'Rendu devoir du ' + prettyDate

        filesToDownload.push({
          filename: `${fileName}.${extension}`,
          fileurl: evl.correctionFile.url,
          shouldReplaceFile: false,
          subPath: PATH_GRADE_CORRECTION.replace('{subject}', prettyCoursName),
          fileAttributes: {
            created_at: date,
            updated_at: date
          }
        })

        const data = await saveFiles(filesToDownload, fields, {
          sourceAccount: fields.account,
          sourceAccountIdentifier: fields.login,
          concurrency: 3,
          qualificationLabel: 'other_work_document', // Corrected subject
          validateFile: () => true
        })

        for (const file of data) {
          if (file['fileDocument']) {
            correctionFiles.push({
              resource: {
                data: {
                  _id: file['fileDocument']['_id'],
                  _type: 'io.cozy.files',
                  metadata: {
                    gradeId: id
                  }
                }
              }
            })
          }
        }
      }

      const njs = {
        id: id,
        label: evl.comment.trim() !== '' ? evl.comment : null,
        date: new Date(evl.date).toISOString(),
        value: {
          student: evl.value.kind == 0 ? evl.value.points : null,
          outOf: evl.outOf.kind == 0 ? evl.outOf.points : null,
          coef: evl.coefficient,
          classAverage: evl.average.kind == 0 ? evl.average.points : null,
          classMax: evl.max.kind == 0 ? evl.max.points : null,
          classMin: evl.min.kind == 0 ? evl.min.points : null
        },
        status: {
          isBonus: evl.isBonus,
          isOptional: evl.isOptional
        }
      }

      evals.push(njs)
    }

    // Create the doctype
    const json = {
      subject: processedCoursName,
      sourceSubject: grade.subject?.name || 'Cours',
      title: grade.period.name,
      startDate: new Date(grade.period.startDate).toISOString(),
      endDate: new Date(grade.period.endDate).toISOString(),
      aggregation: {
        avgGrades: grade.averages?.student?.kind == 0 && grade.averages?.student?.points || -1,
        avgClass: grade.averages?.class_average?.kind == 0 && grade.averages?.class_average?.points || -1,
        maxClass: grade.averages?.max?.kind == 0 && grade.averages?.max?.points || -1,
        minClass: grade.averages?.min?.kind == 0 && grade.averages?.min?.points || -1,
      },
      series: evals,
      relationships:
        subjectFiles.length > 0 || correctionFiles.length > 0
          ? {
              files: {
                data: subjectFiles
              },
              corrections: {
                data: correctionFiles
              }
            }
          : null
    }

    data.push(preprocessDoctype(json))
  }

  return data
}

async function init(session, fields, options) {
  let files = await createGrades(session, fields, options)

  /*
    [Strategy] : don't update grades, they stay the same
    */

  const existing = await queryAllGrades()

  // remove duplicates in files
  const filtered = files.filter(file => {
    const found = existing.find(item => {
      return (
        item?.series?.length === file?.series?.length &&
        item?.startDate === file?.startDate &&
        item?.subject === file?.subject
      )
    })

    return !found
  })

  const res = await updateOrCreate(
    filtered,
    DOCTYPE_GRADE,
    ['startDate', 'subject'],
    {
      sourceAccount: fields.account,
      sourceAccountIdentifier: fields.login
    }
  )

  await saveReports(session, fields, options)

  return res
}

module.exports = init
