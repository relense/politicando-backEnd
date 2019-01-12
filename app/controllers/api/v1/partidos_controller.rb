class Api::V1::PartidosController < ApplicationController
  def index
    partidos = Partido.all

    render json: partidos, status: 200
  end

  def partie_articles
    articles = []
    result = []

    article_ids = ArticlesPartido.where(partido_id: params["partido_id"])

    article_ids.each do |article|
      articles.push(Article.find article.article_id)
    end

    articles_sorted = articles.sort_by { |h| h[:published_time] }.reverse

    articles_sorted.each do |article|
      result.push(article.attributes.merge!({comments_count: article.comments.present? ? article.comments.size : 0}))
    end

    render json: result.first(10), status: 200
  end

  def get_ten
    article_ids = []
    articles = []
    articles_sorted = []
    new_articles = []
    result = []

    article_ids = ArticlesPartido.where(partido_id: params["partido_id"])

    article_ids.each do |article|
      articles.push(Article.find article.article_id)
    end

    articles_sorted = articles.sort_by { |h| h[:published_time] }.reverse
    last_article_index = articles_sorted.index { |h| h[:id] == params["article_id"].to_i}
    new_articles = articles_sorted[(last_article_index + 1)..(last_article_index + 10)]

    new_articles.each do |article|
      result.push(article.attributes.merge!({comments_count: article.comments.present? ? article.comments.size : 0}))
    end

    render json: result, status: 200
  end

end
