export type InquirySourceReport = {
  asOf:string;days:30|90;projectId:string|null;
  sources:{kind:"expose_channel"|"expose_personal"|"crm";label:string;leads:number;qualified:number;archived:number}[];
};
