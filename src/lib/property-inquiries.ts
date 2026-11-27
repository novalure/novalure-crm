export type PropertyInquiryState = {
  counts:{propertyId:string;count:number}[];
  items:{id:string;propertyId:string;propertyTitle:string;leadId:string;leadLabel:string;contactName:string|null;unitNumber:string|null;source:string;campaign:string|null;createdAt:string}[];
};
