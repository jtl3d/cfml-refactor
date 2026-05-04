<cfset prc.report = loadReport(url.startDate, url.endDate)>
<cfoutput>
  Range: #dateFormat(url.startDate)# – #dateFormat(url.endDate)#
</cfoutput>
