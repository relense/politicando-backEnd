require 'open-uri'

class NewsApi::Api

    def top_headlines
        url = 'https://newsapi.org/v2/top-headlines?&sources=google-news&country=pt&apiKey=' + ENV["NEWS_API_KEY"]
        req = open(url)
        response_body = JSON.parse(req.read)

        articles = response_body["articles"]

        articles.each do |article|
            puts article["source"]["name"]
        end

    end

    def every_news
        excluded_domains = "Abola.pt,Ojogo.pt,Record.pt,Estadao.com.br,Macmagazine.com.br"

        url = 'https://newsapi.org/v2/everything?sources=google-news&q=business&excludeDomains=' + excluded_domains +'&language=pt&apiKey=' + ENV["NEWS_API_KEY"]
        req = open(url)
        response_body = JSON.parse(req.read)

        articles = response_body["articles"]

        articles.each do |article|
            puts article["source"]["name"]
        end
    end
end
