export type ProofRetentionPolicy = {id:string;enabled:boolean;graceDays:number;version:number;reason:string;delegated:boolean;scheduler:{ready:boolean;reason:string}};
export type ProofRetentionFile = {proofId:string;fileName:string;kind:string;usableUntil:string;hold:boolean;holdReason:string;holdVersion:number;jobId:string|null;status:'retained'|'queued'|'deleted';eligible:boolean};
export type ProofRetentionChange = {id:string;kind:'policy'|'hold';proofId:string|null;version:number;changedAt:string;actorName:string;reason:string;enabled:boolean;active:boolean;graceDays:number|null};
export type ProofRetentionState = {leadId:string;projectId:string;manager:boolean;policy:ProofRetentionPolicy|null;files:ProofRetentionFile[];changes:ProofRetentionChange[]};
