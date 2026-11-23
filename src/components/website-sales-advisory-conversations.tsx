'use client';

import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Notice } from '@/components/ui/status';
import { advisoryKnowledgeSchema, advisoryTranscriptSchema } from '@/lib/website-sales-advisory-types';
import { AdvisoryChoices, AdvisoryFields, advisoryIso, advisoryText } from './website-sales-advisory-fields';
import { AdvisoryAction, AdvisoryAddRow, AdvisoryRefChoice, AdvisorySources, advisoryLines, advisoryRecords, advisoryRef, advisoryRefKey, advisorySelected, readAdvisorySingleSource, readAdvisorySources, type AdvisoryFormProps } from './website-sales-advisory-form-context';

function milliseconds(value: string) {
  if (!/^\d+(?:[.,]\d{1,3})?$/.test(value)) throw Error('ADVISORY_TIME_REQUIRED');
  const [whole, fraction = ''] = value.replace(',', '.').split('.');
  const result = Number(whole) * 1000 + Number(fraction.padEnd(3, '0'));
  if (!Number.isSafeInteger(result) || result > 14_400_000) throw Error('ADVISORY_TIME_REQUIRED');
  return result;
}
export function AdvisoryTranscriptForms(props: AdvisoryFormProps) {
  const de = props.language === 'de', [segments, setSegments] = useState([0]);
  return <div className="space-y-5">
    <Notice>{de ? 'Dokumentieren Sie nur zulässig verfügbare Gesprächsinhalte. Aussagen aus einer Auswertung bleiben Vorschläge, bis sie mit dem Original geprüft wurden. Ein aufgezeichnetes Gespräch bestätigt keinen Vertragsabschluss.' : 'Record only conversation content you are permitted to use. Analysis remains a proposal until checked against the original. A recorded conversation does not confirm a contract.'}</Notice>
    <AdvisoryAction {...props} operation="register_transcript" title={de ? 'Gespräch mit Originalstellen erfassen' : 'Record a conversation with original passages'} submitLabel={de ? 'Gespräch dokumentieren und Prüfung vorbereiten' : 'Record conversation and prepare review'} build={form => ({
      title: advisoryText(form, 'title'), segments: segments.map(row => ({ id: crypto.randomUUID(), speaker: advisoryText(form, `segment.${row}.speaker`), startMs: milliseconds(advisoryText(form, `segment.${row}.start`)), endMs: milliseconds(advisoryText(form, `segment.${row}.end`)), text: advisoryText(form, `segment.${row}.text`) })),
      permissionReference: readAdvisorySingleSource(form, 'permission', props.data), sourceReferences: readAdvisorySources(form, 'sources', props.data), validUntil: advisoryIso(form, 'validUntil'),
    })}>{context => <>
      <AdvisoryFields context={context} fields={[{ name: 'title', label: de ? 'Gesprächsthema' : 'Conversation title', maxLength: 200 }, { name: 'validUntil', label: de ? 'Erneut prüfen bis' : 'Review again by', type: 'datetime-local' }]}/>
      <div className="space-y-4">{segments.map((row, index) => <fieldset key={row} className="space-y-4 rounded-lg border border-stone-200 p-4"><legend className="px-1 text-sm font-semibold">{de ? 'Originalstelle' : 'Original passage'} {index + 1}</legend>
        <AdvisoryChoices context={context} name={`segment.${row}.speaker`} language={props.language} label={de ? 'Sprecher' : 'Speaker'} choices={[{ value: 'CUSTOMER', label: de ? 'Kunde' : 'Customer' }, { value: 'SELLER', label: de ? 'Novalure' : 'Novalure' }, { value: 'OTHER', label: de ? 'Andere Person' : 'Other speaker' }]}/>
        <AdvisoryFields context={context} fields={[{ name: `segment.${row}.start`, label: de ? 'Beginn in Sekunden' : 'Start in seconds', decimal: true, hint: de ? 'Bis zu drei Nachkommastellen. Die Stellen müssen zeitlich geordnet sein.' : 'Up to three decimal places. Passages must be in time order.' }, { name: `segment.${row}.end`, label: de ? 'Ende in Sekunden' : 'End in seconds', decimal: true }, { name: `segment.${row}.text`, label: de ? 'Wörtlicher Gesprächsausschnitt' : 'Exact conversation passage', multiline: true, maxLength: 1000 }]}/>
        {segments.length > 1 && <Button type="button" variant="ghost" onClick={() => setSegments(values => values.filter(value => value !== row))}>{de ? 'Diese Stelle entfernen' : 'Remove this passage'}</Button>}
      </fieldset>)}</div>
      <AdvisoryAddRow label={de ? 'Weitere Originalstelle' : 'Add original passage'} count={segments.length} maximum={90} add={() => setSegments(values => [...values, Math.max(...values) + 1])}/>
      <AdvisorySources context={context} prefix="permission" label={de ? 'Genau ein Nachweis zur Nutzungserlaubnis' : 'Exactly one evidence reference for permission to use'} data={props.data} language={props.language}/>
      <AdvisorySources context={context} prefix="sources" label={de ? 'Herkunft des Gesprächs' : 'Conversation sources'} data={props.data} language={props.language}/>
    </>}</AdvisoryAction>
  </div>;
}

export function AdvisoryKnowledgeForms(props: AdvisoryFormProps) {
  const de = props.language === 'de', [criteria, setCriteria] = useState<number[]>([]), [scenarios, setScenarios] = useState<number[]>([]);
  const knowledge = advisoryRecords(props.data, 'KNOWLEDGE', advisoryKnowledgeSchema, props.now);
  const transcripts = advisoryRecords(props.data, 'TRANSCRIPT', advisoryTranscriptSchema, props.now);
  const choices = knowledge.map(row => ({ ref: advisoryRef(row), label: row.payload.title }));
  const pick = (form: FormData, name: string) => advisoryRef(advisorySelected(knowledge, advisoryText(form, name), row => advisoryRefKey(advisoryRef(row))));
  return <div className="space-y-5">
    <Notice>{de ? 'Freigegebenes Wissen liefert Gesprächshilfen und Übungssituationen. Eine Simulation kontaktiert keine Kunden. Eine Gesprächsauswertung zeigt beobachtbare Belege und vergibt keine erfundene Leistungsnote.' : 'Approved knowledge supports conversations and practice scenarios. A simulation does not contact customers. Conversation coaching shows observable evidence without inventing a performance score.'}</Notice>
    <AdvisoryAction {...props} operation="register_knowledge" title={de ? 'Gesprächswissen oder Übung anlegen' : 'Create conversation knowledge or practice material'} submitLabel={de ? 'Fassung speichern' : 'Save version'} build={form => ({
      title: advisoryText(form, 'title'), kind: advisoryText(form, 'kind'), content: advisoryText(form, 'content'), disclosure: advisoryText(form, 'disclosure'), rightsReference: readAdvisorySingleSource(form, 'rights', props.data),
      criteria: criteria.map(row => ({ id: `criterion-${row + 1}`, label: advisoryText(form, `criterion.${row}.label`), evidenceTerms: advisoryLines(form, `criterion.${row}.terms`) })),
      scenarios: scenarios.map(row => ({ id: `scenario-${row + 1}`, situation: advisoryText(form, `scenario.${row}.situation`), customerOpening: advisoryText(form, `scenario.${row}.opening`) })), sourceReferences: readAdvisorySources(form, 'sources', props.data), validUntil: advisoryIso(form, 'validUntil'),
    })}>{context => <>
      <AdvisoryFields context={context} fields={[{ name: 'title', label: de ? 'Titel' : 'Title', maxLength: 200 }, { name: 'content', label: de ? 'Geprüfter Inhalt' : 'Reviewed content', multiline: true, maxLength: 2000 }, { name: 'validUntil', label: de ? 'Erneut prüfen bis' : 'Review again by', type: 'datetime-local' }]}/>
      <AdvisoryChoices context={context} name="kind" language={props.language} label={de ? 'Verwendung' : 'Purpose'} choices={[{ value: 'PLAYBOOK', label: de ? 'Gesprächsleitfaden' : 'Conversation playbook' }, { value: 'RUBRIC', label: de ? 'Beobachtungskriterien' : 'Coaching criteria' }, { value: 'ROLEPLAY', label: de ? 'Gesprächssimulation' : 'Role-play' }]}/>
      <AdvisoryChoices context={context} name="disclosure" language={props.language} label={de ? 'Sichtbarkeit' : 'Disclosure'} choices={[{ value: 'INTERNAL', label: de ? 'Nur intern' : 'Internal only' }, { value: 'CUSTOMER_APPROVAL_REQUIRED', label: de ? 'Kundenverwendung benötigt gesonderte Freigabe' : 'Customer use requires separate approval' }]}/>
      {criteria.map((row, index) => <fieldset key={row} className="space-y-3 rounded-lg border border-stone-200 p-4"><legend className="px-1 font-semibold">{de ? 'Beobachtungskriterium' : 'Coaching criterion'} {index + 1}</legend><AdvisoryFields context={context} fields={[{ name: `criterion.${row}.label`, label: de ? 'Worauf achten wir?' : 'What should be observed?', maxLength: 200 }, { name: `criterion.${row}.terms`, label: de ? 'Wörtlich gesuchte Begriffe, ein Begriff je Zeile' : 'Literal evidence terms, one per line', multiline: true, maxLength: 2000 }]}/><Button type="button" variant="ghost" onClick={() => setCriteria(values => values.filter(value => value !== row))}>{de ? 'Kriterium entfernen' : 'Remove criterion'}</Button></fieldset>)}
      <AdvisoryAddRow label={de ? 'Beobachtungskriterium ergänzen' : 'Add coaching criterion'} count={criteria.length} maximum={12} add={() => setCriteria(values => [...values, values.length ? Math.max(...values) + 1 : 0])}/>
      {scenarios.map((row, index) => <fieldset key={row} className="space-y-3 rounded-lg border border-stone-200 p-4"><legend className="px-1 font-semibold">{de ? 'Übungssituation' : 'Practice scenario'} {index + 1}</legend><AdvisoryFields context={context} fields={[{ name: `scenario.${row}.situation`, label: de ? 'Situation' : 'Situation', multiline: true, maxLength: 2000 }, { name: `scenario.${row}.opening`, label: de ? 'Eröffnung des simulierten Kunden' : 'Opening from the simulated customer', multiline: true, maxLength: 2000 }]}/><Button type="button" variant="ghost" onClick={() => setScenarios(values => values.filter(value => value !== row))}>{de ? 'Situation entfernen' : 'Remove scenario'}</Button></fieldset>)}
      <AdvisoryAddRow label={de ? 'Übungssituation ergänzen' : 'Add practice scenario'} count={scenarios.length} maximum={12} add={() => setScenarios(values => [...values, values.length ? Math.max(...values) + 1 : 0])}/>
      <AdvisorySources context={context} prefix="rights" label={de ? 'Genau ein Nachweis zu den Nutzungsrechten' : 'Exactly one evidence reference for usage rights'} data={props.data} language={props.language}/>
      <AdvisorySources context={context} prefix="sources" label={de ? 'Inhaltliche Belege' : 'Content evidence'} data={props.data} language={props.language}/>
    </>}</AdvisoryAction>
    <AdvisoryAction {...props} operation="approve_knowledge" title={de ? 'Exakte Wissensfassung freigeben' : 'Approve the exact knowledge version'} submitLabel={de ? 'Wissensfassung freigeben' : 'Approve knowledge version'} build={form => ({ recordRef: pick(form, 'knowledge'), validUntil: advisoryIso(form, 'validUntil') })}>{context => <><AdvisoryRefChoice context={context} name="knowledge" label={de ? 'Gespeicherte Fassung' : 'Stored version'} choices={choices} language={props.language}/><AdvisoryFields context={context} fields={[{ name: 'validUntil', label: de ? 'Freigabe gültig bis' : 'Approval valid until', type: 'datetime-local' }]}/></>}</AdvisoryAction>
    <AdvisoryAction {...props} operation="assess_coaching" title={de ? 'Gespräch anhand der Kriterien prüfen' : 'Review a conversation against criteria'} submitLabel={de ? 'Belege zu den Kriterien auswerten' : 'Assess evidence for the criteria'} build={form => ({ transcriptRef: advisoryRef(advisorySelected(transcripts, advisoryText(form, 'transcript'), row => advisoryRefKey(advisoryRef(row)))), knowledgeRef: pick(form, 'knowledge') })}>{context => <><AdvisoryRefChoice context={context} name="transcript" label={de ? 'Dokumentiertes Gespräch' : 'Recorded conversation'} choices={transcripts.map(row => ({ ref: advisoryRef(row), label: row.payload.title }))} language={props.language}/><AdvisoryRefChoice context={context} name="knowledge" label={de ? 'Freizugebende Kriterienfassung' : 'Criteria version requiring approval'} choices={choices} language={props.language}/></>}</AdvisoryAction>
    <AdvisoryAction {...props} operation="prepare_roleplay" title={de ? 'Gesprächssimulation vorbereiten' : 'Prepare conversation practice'} submitLabel={de ? 'Simulation vorbereiten' : 'Prepare practice'} build={form => {
      const selected = advisorySelected(knowledge.flatMap(row => row.payload.scenarios.map(scenario => ({ knowledgeRef: advisoryRef(row), scenarioId: scenario.id, key: `${advisoryRefKey(advisoryRef(row))}:${scenario.id}` }))), advisoryText(form, 'scenario'), row => row.key);
      return { knowledgeRef: selected.knowledgeRef, scenarioId: selected.scenarioId };
    }}>{context => <AdvisoryChoices context={context} name="scenario" label={de ? 'Gespeicherte Übungssituation' : 'Stored practice scenario'} language={props.language} choices={knowledge.flatMap(row => row.payload.scenarios.map(scenario => ({ value: `${advisoryRefKey(advisoryRef(row))}:${scenario.id}`, label: `${row.payload.title} · ${scenario.situation}` })))}/>}</AdvisoryAction>
  </div>;
}
