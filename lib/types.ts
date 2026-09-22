export type Photo = { id:string; src:string; thumbnailSrc:string; width:number; height:number; filename:string; title:string; dateTaken:string; location?:{city?:string;region?:string;country?:string;latitude?:number;longitude?:number}; camera?:{make?:string;model?:string;lens?:string;focalLength?:string;aperture?:string;shutterSpeed?:string;iso?:number}; favorite:boolean; tags:string[]; span?:string; color?:string };
export type Trip = {slug:string;name:string;dates:string;count:number;places:string;cover:string};
export type Album = {slug:string;name:string;count:number;cover:string};
