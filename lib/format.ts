// export const ordinal = (number: number) => {
//   const ordinalRules = new Intl.PluralRules('en', {
//     type: 'ordinal',
//   });
//   const suffixes = {
//     one: 'st',
//     two: 'nd',
//     few: 'rd',
//     other: 'th',
//   };
//   /* @ts-ignore */
//   const suffix = suffixes[ordinalRules.select(number)];
//   return number + suffix;
// };

export const ordinal = (n: number) => {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
